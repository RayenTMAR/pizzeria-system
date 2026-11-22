import 'package:flutter/material.dart';
import '../api.dart';
import '../common.dart';
import '../ratings.dart';
import 'manual_order.dart';

const List<String> _euAllergens = [
  'GLUTEN',
  'CRUSTACEANS',
  'EGGS',
  'FISH',
  'PEANUTS',
  'SOYBEANS',
  'MILK',
  'NUTS',
  'CELERY',
  'MUSTARD',
  'SESAME',
  'SULPHITES',
  'LUPIN',
  'MOLLUSCS',
];

const Map<String, String> _allergenEs = {
  'GLUTEN': 'Gluten',
  'CRUSTACEANS': 'Crustáceos',
  'EGGS': 'Huevos',
  'FISH': 'Pescado',
  'PEANUTS': 'Cacahuetes',
  'SOYBEANS': 'Soja',
  'MILK': 'Lácteos',
  'NUTS': 'Frutos de cáscara',
  'CELERY': 'Apio',
  'MUSTARD': 'Mostaza',
  'SESAME': 'Sésamo',
  'SULPHITES': 'Sulfitos',
  'LUPIN': 'Altramuces',
  'MOLLUSCS': 'Moluscos',
};

class JefeHome extends StatelessWidget {
  final String name;
  final VoidCallback onLogout;
  const JefeHome({super.key, required this.name, required this.onLogout});

  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 6,
        child: Scaffold(
          appBar: AppBar(
            title: Text('Jefe · $name'),
            actions: [IconButton(icon: const Icon(Icons.logout), onPressed: onLogout)],
            bottom: const TabBar(
              isScrollable: true,
              tabs: [
                Tab(text: 'Pedidos'),
                Tab(text: 'Repartidores'),
                Tab(text: 'Caja'),
                Tab(text: 'Menú'),
                Tab(text: 'Valoraciones'),
                Tab(text: 'Resumen'),
              ],
            ),
          ),
          body: const TabBarView(children: [
            OrdersTab(),
            RidersTab(),
            CashTab(),
            MenuTab(),
            RatingsView(),
            SummaryTab(),
          ]),
        ),
      );
}

// ---------------------------------------------------------------- Orders
class OrdersTab extends StatefulWidget {
  const OrdersTab({super.key});
  @override
  State<OrdersTab> createState() => _OrdersTabState();
}

class _OrdersTabState extends State<OrdersTab> with Polling, AutomaticKeepAliveClientMixin {
  List<dynamic> orders = [];
  Map<String, dynamic> restaurantStatus = {};
  Set<String>? seen;

  @override
  bool get wantKeepAlive => true; // keep polling (and the new-order sound) on other tabs

  @override
  void initState() {
    super.initState();
    startPolling();
  }

  @override
  Future<void> refresh() async {
    try {
      final results = await Future.wait([
        Api.get('/orders'),
        Api.get('/staff/restaurant/status').catchError((_) => <String, dynamic>{}),
      ]);
      final data = results[0] as List<dynamic>;
      final st = results[1] is Map<String, dynamic> ? results[1] as Map<String, dynamic> : <String, dynamic>{};
      if (seen != null && data.any((o) => o['status'] == 'IN_KITCHEN' && !seen!.contains(o['id']))) {
        alertSound();
      }
      seen = data.map((o) => o['id'] as String).toSet();
      if (mounted) {
        setState(() {
          orders = data;
          restaurantStatus = st;
        });
      }
    } catch (_) {}
  }

  Future<void> _run(Future<dynamic> Function() f) async {
    try {
      await f();
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _setPrepDelay(int extraPrepMinutes) async {
    await _run(() => Api.patch('/staff/restaurant/prep-delay', {'extraPrepMinutes': extraPrepMinutes}));
  }

  Future<void> _optimizeRoute(String riderId) async {
    await _run(() => Api.post('/staff/riders/$riderId/optimize-route'));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Ruta óptima recalculada')),
      );
    }
  }

  Future<void> _reorderStops(String riderId, String riderName, List<Map> activeOrders) async {
    final ordered = [...activeOrders]
      ..sort((a, b) => n(a['stopNumber'] ?? 99).compareTo(n(b['stopNumber'] ?? 99)));
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setD) => AlertDialog(
          title: Text('Ordenar paradas · $riderName'),
          content: SizedBox(
            width: 380,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var i = 0; i < ordered.length; i++)
                  ListTile(
                    dense: true,
                    contentPadding: EdgeInsets.zero,
                    leading: CircleAvatar(radius: 14, child: Text('${i + 1}')),
                    title: Text('#${ordered[i]['number']} · ${ordered[i]['clientName']}'),
                    subtitle: Text(addressLine(ordered[i])),
                    trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                      IconButton(
                        icon: const Icon(Icons.arrow_upward, size: 18),
                        onPressed: i == 0
                            ? null
                            : () => setD(() {
                                  final tmp = ordered[i - 1];
                                  ordered[i - 1] = ordered[i];
                                  ordered[i] = tmp;
                                }),
                      ),
                      IconButton(
                        icon: const Icon(Icons.arrow_downward, size: 18),
                        onPressed: i == ordered.length - 1
                            ? null
                            : () => setD(() {
                                  final tmp = ordered[i + 1];
                                  ordered[i + 1] = ordered[i];
                                  ordered[i] = tmp;
                                }),
                      ),
                    ]),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Guardar orden')),
          ],
        ),
      ),
    );
    if (ok == true) {
      await _run(() => Api.post('/staff/riders/$riderId/reorder-stops', {
            'orderIds': [for (final o in ordered) o['id']],
          }));
    }
  }

  Future<void> _assign(Map o) async {
    try {
      final r = await Api.get('/riders');
      final riders = (r['riders'] as List).cast<Map>();
      final suggested = r['suggestedRiderId'];
      if (!mounted) return;
      if (riders.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Ningún repartidor con turno abierto')));
        return;
      }
      final id = await showDialog<String>(
        context: context,
        builder: (d) => SimpleDialog(
          title: const Text('Asignar repartidor'),
          children: [
            for (final x in riders)
              SimpleDialogOption(
                onPressed: () => Navigator.pop(d, x['id'] as String),
                child: Text('${x['id'] == suggested ? '★ ' : ''}${x['name']} — ${riderStatusEs(x['status'] as String, x['activeOrders'] as int)}'),
              ),
          ],
        ),
      );
      if (id != null) await _run(() => Api.post('/orders/${o['id']}/assign', {'repartidorId': id}));
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _cancel(Map o) async {
    final reason = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Cancelar pedido #${o['number']}'),
        content: TextField(controller: reason, decoration: const InputDecoration(labelText: 'Motivo')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Volver')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Cancelar pedido')),
        ],
      ),
    );
    if (ok == true) await _run(() => Api.post('/orders/${o['id']}/cancel', {'reason': reason.text.trim()}));
  }

  Widget _card(Map o) {
    final st = o['status'] as String;
    final itemsLines = (o['items'] as List).map((i) {
      final mods = ((i['modifiers'] as List?) ?? []).cast<Map>();
      final modStr = mods.isEmpty ? '' : '\n   + ${mods.map((m) => m['optionName']).join(', ')}';
      return '${i['quantity']}× ${i['name']}$modStr';
    }).join('\n');
    final b = <Widget>[];
    if (st == 'IN_KITCHEN') {
      b.add(FilledButton(onPressed: () => _run(() => Api.post('/orders/${o['id']}/ready')), child: const Text('Listo')));
      b.add(OutlinedButton(onPressed: () => _run(() => Api.post('/orders/${o['id']}/reprint')), child: const Text('Reimprimir')));
    }
    if (st == 'READY') b.add(FilledButton(onPressed: () => _assign(o), child: const Text('Asignar')));
    if (st == 'ON_THE_WAY') {
      b.add(OutlinedButton(onPressed: () => _assign(o), child: const Text('Reasignar')));
      if (o['unreachableStartedAt'] != null) {
        b.add(OutlinedButton(
          onPressed: () => _run(() => Api.post('/orders/${o['id']}/unreachable-return')),
          child: const Text('Devolver a tienda'),
        ));
      }
    }
    if (st != 'DELIVERED' && st != 'CANCELLED') {
      b.add(TextButton(onPressed: () => _cancel(o), child: const Text('Cancelar')));
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Row(children: [
            Expanded(
              child: Text(
                '#${o['number']}${o['invoiceNumber'] != null ? ' · Fact. ${o['invoiceNumber']}' : ''} · ${o['clientName']} · ${hhmm(o['createdAt'] as String)}',
                style: Theme.of(context).textTheme.titleMedium,
              ),
            ),
            if (o['stopNumber'] != null && st == 'ON_THE_WAY')
              Chip(
                label: Text('Parada ${o['stopNumber']}'),
                visualDensity: VisualDensity.compact,
              ),
          ]),
          if (o['printFailed'] == true)
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                '⚠ Ticket pendiente de imprimir (>60s)',
                style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold),
              ),
            ),
          if (o['unreachableStartedAt'] != null && st == 'ON_THE_WAY')
            const Padding(
              padding: EdgeInsets.only(top: 4),
              child: Text(
                '⏱ Cliente no contesta (aviso enviado)',
                style: TextStyle(color: Colors.deepOrange, fontWeight: FontWeight.bold),
              ),
            ),
          Text(addressLine(o)),
          Text('Tel: ${o['clientPhone']}'),
          Text(itemsLines),
          Text(payLine(o)),
          if ((o['notes'] ?? '').toString().isNotEmpty)
            Text('Notas: ${o['notes']}', style: const TextStyle(fontStyle: FontStyle.italic)),
          if (o['repartidor'] != null) Text('Repartidor: ${o['repartidor']['name']}'),
          Text('Total ${eur(o['total'])} · ~${o['etaMinutes']} min'),
          if (b.isNotEmpty) Padding(padding: const EdgeInsets.only(top: 8), child: Wrap(spacing: 8, children: b)),
        ]),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    const sections = [
      ['IN_KITCHEN', 'En cocina'],
      ['READY', 'Listos'],
      ['ON_THE_WAY', 'En camino'],
      ['DELIVERED', 'Entregados'],
    ];

    final extraPrep = n(restaurantStatus['extraPrepMinutes'] ?? 0).toInt();
    final printerOffline = restaurantStatus['printerOffline'] == true;
    final unprintedAlerts = ((restaurantStatus['unprintedAlerts'] as List?) ?? []).cast<Map>();

    final onTheWayByRider = <String, List<Map>>{};
    for (final raw in orders) {
      final o = raw as Map;
      if (o['status'] == 'ON_THE_WAY' && o['repartidor'] is Map) {
        final rId = o['repartidor']['id'] as String;
        onTheWayByRider.putIfAbsent(rId, () => []).add(o);
      }
    }

    return Scaffold(
      floatingActionButton: FloatingActionButton.extended(
        icon: const Icon(Icons.add),
        label: const Text('Pedido manual'),
        onPressed: () async {
          await Navigator.push(context, MaterialPageRoute(builder: (_) => const ManualOrderScreen()));
          refresh();
        },
      ),
      body: RefreshIndicator(
        onRefresh: refresh,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(8, 8, 8, 88),
          children: [
            Card(
              child: Padding(
                padding: const EdgeInsets.all(10),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    const Text('Modo hora punta: ', style: TextStyle(fontWeight: FontWeight.w600)),
                    const SizedBox(width: 6),
                    Wrap(spacing: 6, children: [
                      for (final m in [0, 15, 30])
                        ChoiceChip(
                          label: Text(m == 0 ? 'Normal' : '+$m min'),
                          selected: extraPrep == m,
                          onSelected: (_) => _setPrepDelay(m),
                        ),
                    ]),
                  ]),
                  const SizedBox(height: 6),
                  Row(children: [
                    Icon(
                      printerOffline ? Icons.print_disabled : Icons.print,
                      size: 16,
                      color: printerOffline ? Colors.red : Colors.green,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      printerOffline
                          ? 'Impresora CloudPRNT sin señal (>45s)'
                          : (restaurantStatus['lastPrinterPollAt'] != null
                              ? 'Impresora CloudPRNT online'
                              : 'Esperando primera conexión de impresora'),
                      style: TextStyle(
                        fontSize: 12,
                        color: printerOffline ? Colors.red : Colors.black54,
                        fontWeight: printerOffline ? FontWeight.bold : FontWeight.normal,
                      ),
                    ),
                  ]),
                ]),
              ),
            ),
            if (unprintedAlerts.isNotEmpty)
              Card(
                color: Colors.red.shade50,
                child: Padding(
                  padding: const EdgeInsets.all(10),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Text(
                      '⚠ Alerta de impresión (>60s en cocina sin imprimir)',
                      style: TextStyle(color: Colors.red, fontWeight: FontWeight.bold),
                    ),
                    const SizedBox(height: 4),
                    Wrap(
                      spacing: 8,
                      children: [
                        for (final a in unprintedAlerts)
                          ActionChip(
                            label: Text('Reimprimir #${a['number']}'),
                            onPressed: () => _run(() => Api.post('/orders/${a['id']}/reprint')),
                          ),
                      ],
                    ),
                  ]),
                ),
              ),
            for (final entry in onTheWayByRider.entries)
              if (entry.value.length >= 2)
                Card(
                  color: Colors.blue.shade50,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                    child: Wrap(
                      spacing: 8,
                      runSpacing: 6,
                      crossAxisAlignment: WrapCrossAlignment.center,
                      children: [
                        Text(
                          '${entry.value.first['repartidor']['name']} · ${entry.value.length} paradas activas',
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        FilledButton.tonalIcon(
                          icon: const Icon(Icons.route, size: 18),
                          label: const Text('Ordenar ruta óptima'),
                          onPressed: () => _optimizeRoute(entry.key),
                        ),
                        OutlinedButton(
                          onPressed: () => _reorderStops(
                            entry.key,
                            entry.value.first['repartidor']['name'] as String,
                            entry.value,
                          ),
                          child: const Text('Reordenar'),
                        ),
                      ],
                    ),
                  ),
                ),
            for (final s in sections) ...[
              if (orders.any((o) => o['status'] == s[0])) ...[
                Padding(
                  padding: const EdgeInsets.fromLTRB(8, 12, 8, 4),
                  child: Text('${s[1]} (${orders.where((o) => o['status'] == s[0]).length})',
                      style: Theme.of(context).textTheme.titleLarge),
                ),
                for (final o in orders.where((o) => o['status'] == s[0])) _card(o as Map),
              ]
            ],
            if (orders.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Sin pedidos'))),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------- Riders / shifts
class RidersTab extends StatefulWidget {
  const RidersTab({super.key});
  @override
  State<RidersTab> createState() => _RidersTabState();
}

class _RidersTabState extends State<RidersTab> with Polling {
  List<dynamic> all = [];
  Map<String, Map> live = {};

  @override
  void initState() {
    super.initState();
    startPolling();
  }

  @override
  Future<void> refresh() async {
    try {
      final a = await Api.get('/staff/riders') as List<dynamic>;
      final r = await Api.get('/riders');
      final m = <String, Map>{for (final x in (r['riders'] as List)) x['id'] as String: x as Map};
      if (mounted) setState(() { all = a; live = m; });
    } catch (_) {}
  }

  Future<void> _open(Map rider) async {
    final change = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Abrir turno · ${rider['name']}'),
        content: TextField(
          controller: change,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          decoration: const InputDecoration(labelText: 'Cambio entregado (€)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Volver')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Abrir turno')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.post('/shifts/open', {
        'userId': rider['id'],
        'changeGiven': double.tryParse(change.text.replaceAll(',', '.')) ?? 0,
      });
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _close(Map shiftInfo) async {
    try {
      await Api.post('/shifts/${shiftInfo['shiftId']}/close');
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _createRider() async {
    final nameCtl = TextEditingController();
    final emailCtl = TextEditingController();
    final passCtl = TextEditingController();
    final docCtl = TextEditingController();
    final phoneCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Nuevo repartidor'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: nameCtl,
              decoration: const InputDecoration(labelText: 'Nombre'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: emailCtl,
              keyboardType: TextInputType.emailAddress,
              decoration: const InputDecoration(labelText: 'Correo electrónico (login)'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: passCtl,
              obscureText: true,
              decoration: const InputDecoration(labelText: 'Contraseña (login)'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: docCtl,
              decoration: const InputDecoration(labelText: 'DNI / NIE / Pasaporte'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: phoneCtl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Teléfono'),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Crear')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.post('/staff/riders', {
        'name': nameCtl.text.trim(),
        'email': emailCtl.text.trim(),
        'password': passCtl.text,
        'documentNumber': docCtl.text.trim(),
        'phone': phoneCtl.text.trim(),
      });
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editRider(Map rider) async {
    final nameCtl = TextEditingController(text: (rider['name'] ?? '').toString());
    final docCtl = TextEditingController(text: (rider['documentNumber'] ?? '').toString());
    final phoneCtl = TextEditingController(text: (rider['phone'] ?? '').toString());
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Datos del repartidor'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(
              controller: nameCtl,
              decoration: const InputDecoration(labelText: 'Nombre'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: docCtl,
              decoration: const InputDecoration(labelText: 'DNI / NIE / Pasaporte'),
            ),
            const SizedBox(height: 8),
            TextField(
              controller: phoneCtl,
              keyboardType: TextInputType.phone,
              decoration: const InputDecoration(labelText: 'Teléfono'),
            ),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Guardar')),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await Api.patch('/staff/riders/${rider['id']}', {
        if (nameCtl.text.trim().isNotEmpty) 'name': nameCtl.text.trim(),
        'documentNumber': docCtl.text.trim(),
        'phone': phoneCtl.text.trim(),
      });
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  String _riderDetails(Map r) {
    final status = live[r['id']] == null
        ? 'Fuera de turno'
        : riderStatusEs(live[r['id']]!['status'] as String, live[r['id']]!['activeOrders'] as int);
    final doc = (r['documentNumber'] ?? '').toString().trim();
    final phone = (r['phone'] ?? '').toString().trim();
    final meta = [
      if (doc.isNotEmpty) 'Doc: $doc',
      if (phone.isNotEmpty) 'Tel: $phone',
    ].join(' · ');
    return meta.isEmpty ? status : '$meta\n$status';
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: FloatingActionButton.extended(
          icon: const Icon(Icons.person_add_alt_1),
          label: const Text('Nuevo repartidor'),
          onPressed: _createRider,
        ),
        body: ListView(padding: const EdgeInsets.only(bottom: 88), children: [
          for (final r in all.cast<Map>())
            ListTile(
              title: Text(r['name'] as String),
              subtitle: Text(_riderDetails(r)),
              isThreeLine: ((r['documentNumber'] ?? '').toString().isNotEmpty || (r['phone'] ?? '').toString().isNotEmpty),
              trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                IconButton(
                  icon: const Icon(Icons.chat_bubble_outline),
                  tooltip: 'Chat con repartidor',
                  onPressed: () => openChatSheet(
                    context,
                    title: 'Chat · ${r['name']}',
                    endpoint: '/chat/staff/${r['id']}',
                    myRole: 'JEFE',
                  ),
                ),
                IconButton(
                  icon: const Icon(Icons.edit_outlined),
                  tooltip: 'Editar datos',
                  onPressed: () => _editRider(r),
                ),
                live[r['id']] == null
                    ? FilledButton(onPressed: () => _open(r), child: const Text('Abrir turno'))
                    : OutlinedButton(onPressed: () => _close(live[r['id']]!), child: const Text('Cerrar turno')),
              ]),
            ),
          if (all.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Sin repartidores'))),
        ]),
      );
}

// ---------------------------------------------------------------- Cash settlement (jefe only)
class CashTab extends StatefulWidget {
  const CashTab({super.key});
  @override
  State<CashTab> createState() => _CashTabState();
}

class _CashTabState extends State<CashTab> with Polling {
  List<dynamic> shifts = [];

  @override
  void initState() {
    super.initState();
    startPolling();
  }

  @override
  Future<void> refresh() async {
    try {
      final d = await Api.get('/shifts') as List<dynamic>;
      if (mounted) setState(() => shifts = d);
    } catch (_) {}
  }

  String _label(Map s) {
    if (s['endedAt'] == null) return 'en curso';
    switch (s['settlement']) {
      case 'BALANCED':
        return 'cuadrado';
      case 'DIFFERENCE':
        return 'diferencia ${eur(s['difference'])}';
      default:
        return 'pendiente de liquidar';
    }
  }

  Future<void> _settle(Map s) async {
    Map sum;
    try {
      sum = await Api.get('/shifts/${s['id']}/summary') as Map;
    } catch (e) {
      if (mounted) showError(context, e);
      return;
    }
    if (!mounted) return;
    final diff = TextEditingController(
      text: s['difference'] != null && n(s['difference']) != 0 ? s['difference'].toString() : '',
    );
    final note = TextEditingController(text: (s['settlementNote'] ?? '').toString());
    final closed = s['endedAt'] != null;
    var editing = s['settlement'] == 'PENDING';
    final cards = (sum['cardPayments'] as List).cast<Map>();
    final res = await showDialog<String>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setDialogState) => AlertDialog(
          title: Text('Turno de ${s['user']['name']}'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Entregas: ${sum['deliveries']}'),
              Text('Efectivo cobrado: ${eur(sum['cashCollected'])}'),
              Text('Cambio entregado: ${eur(sum['changeGiven'])}'),
              Text('Efectivo a recibir: ${eur(sum['cashDue'])}', style: const TextStyle(fontWeight: FontWeight.bold)),
              const SizedBox(height: 8),
              Text('Pagos con tarjeta: ${cards.length}'),
              for (final c in cards) Text('   #${c['orderNumber']} — ${eur(c['amount'])}'),
              if (closed && !editing) ...[
                const SizedBox(height: 8),
                Text('Estado: ${_label(s)}', style: const TextStyle(fontWeight: FontWeight.w600)),
                if ((s['settlementNote'] ?? '').toString().isNotEmpty) Text('Nota: ${s['settlementNote']}'),
              ],
              if (closed && editing) ...[
                TextField(
                  controller: diff,
                  keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
                  decoration: const InputDecoration(labelText: 'Diferencia (− falta, + sobra)'),
                ),
                TextField(controller: note, decoration: const InputDecoration(labelText: 'Nota')),
              ],
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, 'close'), child: const Text('Cerrar')),
            if (closed && !editing)
              OutlinedButton(
                onPressed: () => setDialogState(() => editing = true),
                child: const Text('Corregir'),
              ),
            if (closed && editing) ...[
              TextButton(onPressed: () => Navigator.pop(d, 'diff'), child: const Text('Con diferencia')),
              FilledButton(onPressed: () => Navigator.pop(d, 'ok'), child: const Text('Cuadrado')),
            ],
          ],
        ),
      ),
    );
    if (res != 'ok' && res != 'diff') return;
    try {
      await Api.post('/shifts/${s['id']}/settle', {
        'settlement': res == 'ok' ? 'BALANCED' : 'DIFFERENCE',
        if (res == 'diff') 'difference': double.tryParse(diff.text.replaceAll(',', '.')) ?? 0,
        if (note.text.trim().isNotEmpty) 'note': note.text.trim(),
      });
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => ListView(children: [
        for (final s in shifts.cast<Map>())
          ListTile(
            title: Text(s['user']['name'] as String),
            subtitle: Text('${hhmm(s['startedAt'] as String)}–${s['endedAt'] == null ? '…' : hhmm(s['endedAt'] as String)} · ${_label(s)}'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _settle(s),
          ),
        if (shifts.isEmpty) const Padding(padding: EdgeInsets.all(32), child: Center(child: Text('Sin turnos hoy'))),
      ]);
}

// ---------------------------------------------------------------- Menu editor (jefe only)
class MenuTab extends StatefulWidget {
  const MenuTab({super.key});
  @override
  State<MenuTab> createState() => _MenuTabState();
}

class _MenuTabState extends State<MenuTab> {
  List<dynamic> categories = [];
  List<dynamic> modifierGroups = [];

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        Api.get('/menu?all=1'),
        Api.get('/menu/modifier-groups').catchError((_) => <dynamic>[]),
      ]);
      if (mounted) {
        setState(() {
          categories = results[0] as List<dynamic>;
          modifierGroups = results[1] as List<dynamic>;
        });
      }
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _createModifierGroup() async {
    final nameCtl = TextEditingController();
    final minCtl = TextEditingController(text: '0');
    final maxCtl = TextEditingController(text: '1');
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Nuevo grupo de modificadores'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: nameCtl, decoration: const InputDecoration(labelText: 'Nombre (ej.: Tamaño, Extras, Salsas)')),
            const SizedBox(height: 8),
            TextField(controller: minCtl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Mín. selecciones (1 = obligatorio)')),
            const SizedBox(height: 8),
            TextField(controller: maxCtl, keyboardType: TextInputType.number, decoration: const InputDecoration(labelText: 'Máx. selecciones (1 = única, >1 = múltiple)')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Crear')),
        ],
      ),
    );
    if (ok != true || nameCtl.text.trim().isEmpty) return;
    try {
      await Api.post('/menu/modifier-groups', {
        'name': nameCtl.text.trim(),
        'minSelections': int.tryParse(minCtl.text.trim()) ?? 0,
        'maxSelections': (int.tryParse(maxCtl.text.trim()) ?? 1).clamp(1, 50).toInt(),
      });
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _deleteModifierGroup(Map g) async {
    final ok = await confirm(context, 'Eliminar grupo', '¿Eliminar el grupo "${g['name']}" y sus opciones?');
    if (!ok) return;
    try {
      await Api.delete('/menu/modifier-groups/${g['id']}');
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _createModifierOption(Map g) async {
    final nameCtl = TextEditingController();
    final deltaCtl = TextEditingController(text: '0.00');
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Nueva opción en ${g['name']}'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: nameCtl, decoration: const InputDecoration(labelText: 'Nombre (ej.: Familiar, Extra Queso)')),
          const SizedBox(height: 8),
          TextField(
            controller: deltaCtl,
            keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
            decoration: const InputDecoration(labelText: 'Suplemento (€)'),
          ),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Añadir')),
        ],
      ),
    );
    if (ok != true || nameCtl.text.trim().isEmpty) return;
    try {
      await Api.post('/menu/modifier-options', {
        'modifierGroupId': g['id'],
        'name': nameCtl.text.trim(),
        'priceDelta': double.tryParse(deltaCtl.text.replaceAll(',', '.')) ?? 0,
      });
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _toggleModifierOption(Map opt, bool v) async {
    try {
      await Api.patch('/menu/modifier-options/${opt['id']}', {'isAvailable': v});
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _deleteModifierOption(Map opt) async {
    try {
      await Api.delete('/menu/modifier-options/${opt['id']}');
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editCategory([Map? cat]) async {
    final nameCtl = TextEditingController(text: (cat?['name'] ?? '').toString());
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(cat == null ? 'Nueva categoría' : 'Editar categoría'),
        content: TextField(
          controller: nameCtl,
          decoration: const InputDecoration(labelText: 'Nombre de la categoría (ej.: Pizzas, Kebab, Bebidas)'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Guardar')),
        ],
      ),
    );
    if (ok != true || nameCtl.text.trim().isEmpty) return;
    try {
      if (cat == null) {
        await Api.post('/menu/categories', {'name': nameCtl.text.trim()});
      } else {
        await Api.patch('/menu/categories/${cat['id']}', {'name': nameCtl.text.trim()});
      }
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _deleteCategory(Map cat) async {
    final ok = await confirm(context, 'Eliminar categoría', '¿Eliminar la categoría "${cat['name']}"?');
    if (!ok) return;
    try {
      await Api.delete('/menu/categories/${cat['id']}');
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editProduct(String categoryId, [Map? prod]) async {
    final nameCtl = TextEditingController(text: (prod?['name'] ?? '').toString());
    final descCtl = TextEditingController(text: (prod?['description'] ?? '').toString());
    final priceCtl = TextEditingController(text: prod != null ? n(prod['price']).toStringAsFixed(2) : '');
    var available = prod == null ? true : (prod['available'] as bool? ?? true);
    var isCombo = prod != null && prod['isCombo'] == true;
    var vatRate = prod != null && prod['vatRate'] != null ? n(prod['vatRate']).toDouble() : 10.0;
    var selectedCatId = (prod?['categoryId'] ?? categoryId).toString();
    final selectedAllergens = <String>{
      for (final a in ((prod?['allergens'] as List?) ?? [])) a.toString(),
    };
    final selectedGroupIds = <String>[
      for (final link in ((prod?['modifierGroups'] as List?) ?? []).cast<Map>())
        if (link['modifierGroupId'] != null)
          link['modifierGroupId'].toString()
        else if (link['modifierGroup'] is Map)
          link['modifierGroup']['id'].toString(),
    ];

    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setDialogState) => AlertDialog(
          title: Text(prod == null ? 'Nuevo plato / producto' : 'Editar plato / producto'),
          content: SizedBox(
            width: 460,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  DropdownButtonFormField<String>(
                    value: selectedCatId,
                    decoration: const InputDecoration(labelText: 'Categoría'),
                    items: [
                      for (final c in categories.cast<Map>())
                        DropdownMenuItem(value: c['id'] as String, child: Text(c['name'] as String))
                    ],
                    onChanged: (v) => setDialogState(() => selectedCatId = v ?? categoryId),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: nameCtl,
                    decoration: const InputDecoration(labelText: 'Nombre (ej.: Margarita, Kebab mixto)'),
                  ),
                  const SizedBox(height: 8),
                  TextField(
                    controller: descCtl,
                    maxLines: 2,
                    decoration: const InputDecoration(labelText: 'Descripción / ingredientes (opcional)'),
                  ),
                  const SizedBox(height: 8),
                  Row(children: [
                    Expanded(
                      child: TextField(
                        controller: priceCtl,
                        keyboardType: const TextInputType.numberWithOptions(decimal: true),
                        decoration: const InputDecoration(labelText: 'Precio (€)'),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: DropdownButtonFormField<double>(
                        value: vatRate == 21.0 ? 21.0 : (vatRate == 4.0 ? 4.0 : 10.0),
                        decoration: const InputDecoration(labelText: 'IVA (%)'),
                        items: const [
                          DropdownMenuItem(value: 10.0, child: Text('10% (Hostelería)')),
                          DropdownMenuItem(value: 21.0, child: Text('21% (Bebidas/Alcohol)')),
                          DropdownMenuItem(value: 4.0, child: Text('4% (Superreducido)')),
                        ],
                        onChanged: (v) => setDialogState(() => vatRate = v ?? 10.0),
                      ),
                    ),
                  ]),
                  const SizedBox(height: 4),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Disponible en la carta'),
                    value: available,
                    onChanged: (v) => setDialogState(() => available = v),
                  ),
                  SwitchListTile(
                    contentPadding: EdgeInsets.zero,
                    title: const Text('Es un Combo / Menú (pasos)'),
                    value: isCombo,
                    onChanged: (v) => setDialogState(() => isCombo = v),
                  ),
                  const SizedBox(height: 6),
                  const Text('Alérgenos UE (14 obligatorios)', style: TextStyle(fontWeight: FontWeight.w600)),
                  const SizedBox(height: 4),
                  Wrap(
                    spacing: 6,
                    runSpacing: 4,
                    children: [
                      for (final code in _euAllergens)
                        FilterChip(
                          label: Text(_allergenEs[code] ?? code, style: const TextStyle(fontSize: 12)),
                          selected: selectedAllergens.contains(code),
                          onSelected: (sel) => setDialogState(() {
                            if (sel) {
                              selectedAllergens.add(code);
                            } else {
                              selectedAllergens.remove(code);
                            }
                          }),
                        ),
                    ],
                  ),
                  if (modifierGroups.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    const Text('Grupos de modificadores', style: TextStyle(fontWeight: FontWeight.w600)),
                    for (final g in modifierGroups.cast<Map>())
                      CheckboxListTile(
                        dense: true,
                        contentPadding: EdgeInsets.zero,
                        controlAffinity: ListTileControlAffinity.leading,
                        title: Text(g['name'] as String),
                        value: selectedGroupIds.contains(g['id']),
                        onChanged: (v) => setDialogState(() {
                          final gid = g['id'] as String;
                          if (v == true) {
                            if (!selectedGroupIds.contains(gid)) selectedGroupIds.add(gid);
                          } else {
                            selectedGroupIds.remove(gid);
                          }
                        }),
                      ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Guardar')),
          ],
        ),
      ),
    );
    if (ok != true || nameCtl.text.trim().isEmpty) return;
    final price = double.tryParse(priceCtl.text.replaceAll(',', '.')) ?? 0;
    final payload = {
      'categoryId': selectedCatId,
      'name': nameCtl.text.trim(),
      'description': descCtl.text.trim(),
      'price': price,
      'available': available,
      'isCombo': isCombo,
      'vatRate': vatRate,
      'allergens': selectedAllergens.toList(),
      'modifierGroupIds': selectedGroupIds,
    };
    try {
      if (prod == null) {
        await Api.post('/menu/products', payload);
      } else {
        await Api.patch('/menu/products/${prod['id']}', payload);
      }
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _toggleAvailable(Map prod, bool v) async {
    try {
      await Api.patch('/menu/products/${prod['id']}', {'available': v});
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _deleteProduct(Map prod) async {
    final ok = await confirm(context, 'Eliminar producto', '¿Eliminar "${prod['name']}" de la carta?');
    if (!ok) return;
    try {
      await Api.delete('/menu/products/${prod['id']}');
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        floatingActionButton: FloatingActionButton.extended(
          icon: const Icon(Icons.create_new_folder_outlined),
          label: const Text('Nueva categoría'),
          onPressed: () => _editCategory(),
        ),
        body: RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 88),
            children: [
              Card(
                margin: const EdgeInsets.only(bottom: 12),
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Row(children: [
                      Expanded(
                        child: Text('Grupos de modificadores y extras', style: Theme.of(context).textTheme.titleMedium),
                      ),
                      FilledButton.tonalIcon(
                        icon: const Icon(Icons.add, size: 18),
                        label: const Text('Nuevo grupo'),
                        onPressed: _createModifierGroup,
                      ),
                    ]),
                    if (modifierGroups.isEmpty)
                      const Padding(
                        padding: EdgeInsets.only(top: 8),
                        child: Text('Sin grupos de modificadores todavía.'),
                      ),
                    for (final g in modifierGroups.cast<Map>()) ...[
                      const Divider(),
                      Row(children: [
                        Expanded(
                          child: Text(
                            '${g['name']} (Mín ${g['minSelections']} · Máx ${g['maxSelections']})',
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),
                        ),
                        TextButton.icon(
                          icon: const Icon(Icons.add, size: 16),
                          label: const Text('Opción'),
                          onPressed: () => _createModifierOption(g),
                        ),
                        IconButton(
                          icon: const Icon(Icons.delete_outline, size: 20),
                          onPressed: () => _deleteModifierGroup(g),
                        ),
                      ]),
                      for (final o in ((g['options'] as List?) ?? []).cast<Map>())
                        ListTile(
                          dense: true,
                          contentPadding: const EdgeInsets.only(left: 12),
                          title: Text('${o['name']} (+${eur(o['priceDelta'])})'),
                          subtitle: Text(o['isAvailable'] != false ? 'Disponible' : 'Agotado'),
                          trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                            Switch(
                              value: o['isAvailable'] != false,
                              onChanged: (v) => _toggleModifierOption(o, v),
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete_outline, size: 18),
                              onPressed: () => _deleteModifierOption(o),
                            ),
                          ]),
                        ),
                    ],
                  ]),
                ),
              ),
              for (final cat in categories.cast<Map>())
                Card(
                  margin: const EdgeInsets.only(bottom: 12),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Row(children: [
                        Expanded(
                          child: Text(cat['name'] as String, style: Theme.of(context).textTheme.titleMedium),
                        ),
                        IconButton(
                          icon: const Icon(Icons.edit_outlined),
                          tooltip: 'Renombrar categoría',
                          onPressed: () => _editCategory(cat),
                        ),
                        IconButton(
                          icon: const Icon(Icons.delete_outline),
                          tooltip: 'Eliminar categoría',
                          onPressed: () => _deleteCategory(cat),
                        ),
                        FilledButton.tonalIcon(
                          icon: const Icon(Icons.add, size: 18),
                          label: const Text('Añadir plato'),
                          onPressed: () => _editProduct(cat['id'] as String),
                        ),
                      ]),
                      const Divider(),
                      if ((cat['products'] as List).isEmpty)
                        const Padding(
                          padding: EdgeInsets.symmetric(vertical: 8),
                          child: Text('Sin productos en esta categoría'),
                        ),
                      for (final p in (cat['products'] as List).cast<Map>())
                        Builder(builder: (_) {
                          final allergens = ((p['allergens'] as List?) ?? []).cast<String>();
                          final groups = ((p['modifierGroups'] as List?) ?? []).cast<Map>();
                          final desc = (p['description'] ?? '').toString();
                          final details = <String>[
                            if (desc.isNotEmpty) desc,
                            'IVA ${n(p['vatRate'] ?? 10).toStringAsFixed(0)}%${p['isCombo'] == true ? ' · COMBO' : ''}',
                            if (allergens.isNotEmpty)
                              'Alérgenos: ${allergens.map((a) => _allergenEs[a] ?? a).join(', ')}',
                            if (groups.isNotEmpty)
                              'Modificadores: ${groups.map((g) => g['modifierGroup']?['name'] ?? '').where((s) => s.toString().isNotEmpty).join(', ')}',
                          ];
                          return ListTile(
                            contentPadding: EdgeInsets.zero,
                            title: Text(
                              '${p['name']} · ${eur(p['price'])}',
                              style: TextStyle(
                                fontWeight: FontWeight.w600,
                                decoration: (p['available'] as bool? ?? true) ? null : TextDecoration.lineThrough,
                              ),
                            ),
                            subtitle: Text(details.join('\n')),
                            trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                              Switch(
                                value: p['available'] as bool? ?? true,
                                onChanged: (v) => _toggleAvailable(p, v),
                              ),
                              IconButton(
                                icon: const Icon(Icons.edit_outlined),
                                onPressed: () => _editProduct(cat['id'] as String, p),
                              ),
                              IconButton(
                                icon: const Icon(Icons.delete_outline),
                                onPressed: () => _deleteProduct(p),
                              ),
                            ]),
                          );
                        }),
                    ]),
                  ),
                ),
              if (categories.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(32),
                  child: Center(child: Text('No hay categorías. Pulsa "Nueva categoría" para empezar.')),
                ),
            ],
          ),
        ),
      );
}

// ---------------------------------------------------------------- Summary, Fiscal, Zones & Promos (jefe only)
class SummaryTab extends StatefulWidget {
  const SummaryTab({super.key});
  @override
  State<SummaryTab> createState() => _SummaryTabState();
}

class _SummaryTabState extends State<SummaryTab> {
  Map<String, dynamic>? analytics;
  List<dynamic> zones = [];
  List<dynamic> promos = [];
  final legalCtl = TextEditingController();
  final nifCtl = TextEditingController();
  final fiscalAddrCtl = TextEditingController();
  final vatCtl = TextEditingController(text: '10.00');
  bool printReceipt = true;
  bool savingFiscal = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    legalCtl.dispose();
    nifCtl.dispose();
    fiscalAddrCtl.dispose();
    vatCtl.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        Api.get('/staff/analytics'),
        Api.get('/staff/restaurant/status'),
        Api.get('/staff/zones'),
        Api.get('/staff/promos'),
      ]);
      final st = results[1] as Map<String, dynamic>;
      if (!mounted) return;
      setState(() {
        analytics = results[0] as Map<String, dynamic>;
        zones = results[2] as List<dynamic>;
        promos = results[3] as List<dynamic>;
        legalCtl.text = (st['legalName'] ?? '').toString();
        nifCtl.text = (st['nifCif'] ?? '').toString();
        fiscalAddrCtl.text = (st['fiscalAddress'] ?? '').toString();
        vatCtl.text = n(st['defaultVatRate'] ?? 10).toStringAsFixed(2);
        printReceipt = st['printCustomerReceipt'] != false;
      });
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _saveFiscal() async {
    setState(() => savingFiscal = true);
    try {
      await Api.patch('/staff/restaurant/fiscal', {
        if (legalCtl.text.trim().isNotEmpty) 'legalName': legalCtl.text.trim(),
        if (nifCtl.text.trim().isNotEmpty) 'nifCif': nifCtl.text.trim(),
        if (fiscalAddrCtl.text.trim().isNotEmpty) 'fiscalAddress': fiscalAddrCtl.text.trim(),
        if (double.tryParse(vatCtl.text.replaceAll(',', '.')) != null)
          'defaultVatRate': double.parse(vatCtl.text.replaceAll(',', '.')),
        'printCustomerReceipt': printReceipt,
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Configuración fiscal guardada')));
      }
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => savingFiscal = false);
    }
  }

  Future<void> _createZone() async {
    final nameCtl = TextEditingController();
    final minKmCtl = TextEditingController(text: '0');
    final maxKmCtl = TextEditingController(text: '3');
    final feeCtl = TextEditingController(text: '1.50');
    final minOrdCtl = TextEditingController(text: '10.00');
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Nueva zona de reparto'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            TextField(controller: nameCtl, decoration: const InputDecoration(labelText: 'Nombre (ej.: Zona Centro)')),
            TextField(controller: minKmCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Km mínimos')),
            TextField(controller: maxKmCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Km máximos')),
            TextField(controller: feeCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Gastos de envío (€)')),
            TextField(controller: minOrdCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Pedido mínimo (€)')),
          ]),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
          FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Guardar')),
        ],
      ),
    );
    if (ok != true || nameCtl.text.trim().isEmpty) return;
    try {
      await Api.post('/staff/zones', {
        'name': nameCtl.text.trim(),
        'minKm': double.tryParse(minKmCtl.text.replaceAll(',', '.')) ?? 0,
        'maxKm': double.tryParse(maxKmCtl.text.replaceAll(',', '.')) ?? 3,
        'deliveryFee': double.tryParse(feeCtl.text.replaceAll(',', '.')) ?? 0,
        'minOrderAmount': double.tryParse(minOrdCtl.text.replaceAll(',', '.')) ?? 0,
      });
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _createPromo() async {
    final codeCtl = TextEditingController();
    final valCtl = TextEditingController(text: '10');
    final minOrdCtl = TextEditingController(text: '15');
    var type = 'PERCENTAGE';
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setD) => AlertDialog(
          title: const Text('Nuevo código promocional'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              TextField(controller: codeCtl, decoration: const InputDecoration(labelText: 'Código (ej.: BIENVENIDA)')),
              const SizedBox(height: 8),
              DropdownButtonFormField<String>(
                value: type,
                decoration: const InputDecoration(labelText: 'Tipo de descuento'),
                items: const [
                  DropdownMenuItem(value: 'PERCENTAGE', child: Text('Porcentaje (%)')),
                  DropdownMenuItem(value: 'FIXED_AMOUNT', child: Text('Importe fijo (€)')),
                ],
                onChanged: (v) => setD(() => type = v ?? 'PERCENTAGE'),
              ),
              TextField(controller: valCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Valor del descuento')),
              TextField(controller: minOrdCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'Pedido mínimo (€)')),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancelar')),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: const Text('Guardar')),
          ],
        ),
      ),
    );
    if (ok != true || codeCtl.text.trim().isEmpty) return;
    try {
      await Api.post('/staff/promos', {
        'code': codeCtl.text.trim().toUpperCase(),
        'discountType': type,
        'discountValue': double.tryParse(valCtl.text.replaceAll(',', '.')) ?? 10,
        'minOrderAmount': double.tryParse(minOrdCtl.text.replaceAll(',', '.')) ?? 0,
      });
      await _load();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final a = analytics;
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(padding: const EdgeInsets.all(12), children: [
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Analíticas del día (desde las 02:00)', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              if (a == null)
                const LinearProgressIndicator()
              else ...[
                Text('Facturación bruta: ${eur(a['grossRevenue'])} (${a['orderCount']} pedidos)',
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                Text('Base imponible neta: ${eur(a['netAmount'])} · IVA: ${eur(a['vatAmount'])}'),
                Text('Ticket medio: ${eur(a['averageTicket'])}'),
                Text('Efectivo: ${eur(a['cashTotal'])} (${a['cashCount']}) · Tarjeta: ${eur(a['cardTotal'])} (${a['cardCount']})'),
                Text('T. medio cocina: ${a['avgPrepMinutes']} min · T. medio entrega: ${a['avgDeliveryMinutes']} min'),
                if (((a['topProducts'] as List?) ?? []).isNotEmpty) ...[
                  const SizedBox(height: 6),
                  const Text('Top productos:', style: TextStyle(fontWeight: FontWeight.w600)),
                  for (final p in (a['topProducts'] as List).cast<Map>())
                    Text('  • ${p['quantity']}× ${p['name']} (${eur(p['revenue'])})'),
                ],
                if (((a['deliveriesByRider'] as List?) ?? []).isNotEmpty) ...[
                  const SizedBox(height: 6),
                  const Text('Entregas por repartidor:', style: TextStyle(fontWeight: FontWeight.w600)),
                  for (final r in (a['deliveriesByRider'] as List).cast<Map>())
                    Text('  • ${r['name']}: ${r['deliveries']}'),
                ],
              ],
            ]),
          ),
        ),
        const SizedBox(height: 10),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('Datos fiscales (Factura Simplificada / Veri*factu)', style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              TextField(controller: legalCtl, decoration: const InputDecoration(labelText: 'Razón social')),
              TextField(controller: nifCtl, decoration: const InputDecoration(labelText: 'NIF / CIF')),
              TextField(controller: fiscalAddrCtl, decoration: const InputDecoration(labelText: 'Dirección fiscal')),
              TextField(controller: vatCtl, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'IVA por defecto (%)')),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Imprimir doble ticket (Cocina + Cliente) en CloudPRNT'),
                value: printReceipt,
                onChanged: (v) => setState(() => printReceipt = v),
              ),
              FilledButton(
                onPressed: savingFiscal ? null : _saveFiscal,
                child: Text(savingFiscal ? 'Guardando…' : 'Guardar configuración fiscal'),
              ),
            ]),
          ),
        ),
        const SizedBox(height: 10),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('Zonas de reparto', style: Theme.of(context).textTheme.titleMedium)),
                FilledButton.tonalIcon(icon: const Icon(Icons.add, size: 18), label: const Text('Zona'), onPressed: _createZone),
              ]),
              if (zones.isEmpty) const Text('Sin zonas configuradas (tarifa base del restaurante).'),
              for (final z in zones.cast<Map>())
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text('${z['name']} (${z['minKm']}–${z['maxKm']} km)'),
                  subtitle: Text('Envío: ${eur(z['deliveryFee'])} · Pedido mín.: ${eur(z['minOrderAmount'])}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      await Api.delete('/staff/zones/${z['id']}');
                      _load();
                    },
                  ),
                ),
            ]),
          ),
        ),
        const SizedBox(height: 10),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(child: Text('Códigos promocionales', style: Theme.of(context).textTheme.titleMedium)),
                FilledButton.tonalIcon(icon: const Icon(Icons.add, size: 18), label: const Text('Cupón'), onPressed: _createPromo),
              ]),
              if (promos.isEmpty) const Text('Sin códigos promocionales activos.'),
              for (final p in promos.cast<Map>())
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text('${p['code']} · ${p['discountType'] == 'PERCENTAGE' ? '${p['discountValue']}%' : eur(p['discountValue'])}'),
                  subtitle: Text('Mínimo: ${eur(p['minOrderAmount'])} · Usos: ${p['usesCount'] ?? 0}'),
                  trailing: IconButton(
                    icon: const Icon(Icons.delete_outline),
                    onPressed: () async {
                      await Api.delete('/staff/promos/${p['id']}');
                      _load();
                    },
                  ),
                ),
            ]),
          ),
        ),
      ]),
    );
  }
}

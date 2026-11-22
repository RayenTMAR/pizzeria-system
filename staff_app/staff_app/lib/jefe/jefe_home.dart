import 'package:flutter/material.dart';
import '../api.dart';
import '../common.dart';
import '../ratings.dart';
import 'manual_order.dart';

class JefeHome extends StatelessWidget {
  final String name;
  final VoidCallback onLogout;
  const JefeHome({super.key, required this.name, required this.onLogout});

  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 5,
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
              ],
            ),
          ),
          body: const TabBarView(children: [OrdersTab(), RidersTab(), CashTab(), MenuTab(), RatingsView()]),
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
      final data = await Api.get('/orders') as List<dynamic>;
      if (seen != null && data.any((o) => o['status'] == 'IN_KITCHEN' && !seen!.contains(o['id']))) {
        alertSound();
      }
      seen = data.map((o) => o['id'] as String).toSet();
      if (mounted) setState(() => orders = data);
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
    final items = (o['items'] as List).map((i) => '${i['quantity']}× ${i['name']}').join(', ');
    final b = <Widget>[];
    if (st == 'IN_KITCHEN') {
      b.add(FilledButton(onPressed: () => _run(() => Api.post('/orders/${o['id']}/ready')), child: const Text('Listo')));
      b.add(OutlinedButton(onPressed: () => _run(() => Api.post('/orders/${o['id']}/reprint')), child: const Text('Reimprimir')));
    }
    if (st == 'READY') b.add(FilledButton(onPressed: () => _assign(o), child: const Text('Asignar')));
    if (st == 'ON_THE_WAY') b.add(OutlinedButton(onPressed: () => _assign(o), child: const Text('Reasignar')));
    if (st != 'DELIVERED' && st != 'CANCELLED') {
      b.add(TextButton(onPressed: () => _cancel(o), child: const Text('Cancelar')));
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('#${o['number']} · ${o['clientName']} · ${hhmm(o['createdAt'] as String)}',
              style: Theme.of(context).textTheme.titleMedium),
          Text(addressLine(o)),
          Text('Tel: ${o['clientPhone']}'),
          Text(items),
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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await Api.get('/menu?all=1') as List<dynamic>;
      if (mounted) setState(() => categories = d);
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
    var selectedCatId = (prod?['categoryId'] ?? categoryId).toString();

    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setDialogState) => AlertDialog(
          title: Text(prod == null ? 'Nuevo plato / producto' : 'Editar plato / producto'),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
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
              TextField(
                controller: priceCtl,
                keyboardType: const TextInputType.numberWithOptions(decimal: true),
                decoration: const InputDecoration(labelText: 'Precio (€)'),
              ),
              const SizedBox(height: 8),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Disponible en la carta'),
                value: available,
                onChanged: (v) => setDialogState(() => available = v),
              ),
            ]),
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
    try {
      if (prod == null) {
        await Api.post('/menu/products', {
          'categoryId': selectedCatId,
          'name': nameCtl.text.trim(),
          'description': descCtl.text.trim(),
          'price': price,
          'available': available,
        });
      } else {
        await Api.patch('/menu/products/${prod['id']}', {
          'categoryId': selectedCatId,
          'name': nameCtl.text.trim(),
          'description': descCtl.text.trim(),
          'price': price,
          'available': available,
        });
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
                        ListTile(
                          contentPadding: EdgeInsets.zero,
                          title: Text(
                            '${p['name']} · ${eur(p['price'])}',
                            style: TextStyle(
                              fontWeight: FontWeight.w600,
                              decoration: (p['available'] as bool? ?? true) ? null : TextDecoration.lineThrough,
                            ),
                          ),
                          subtitle: (p['description'] ?? '').toString().isNotEmpty
                              ? Text(p['description'] as String)
                              : null,
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
                        ),
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

import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:url_launcher/url_launcher.dart';
import '../api.dart';
import '../common.dart';
import '../l10n.dart';
import '../ratings.dart';

class RiderHome extends StatefulWidget {
  final String name;
  final VoidCallback onLogout;
  // In production on device, pass a callback backed by geolocator.
  final Future<Map<String, double>?> Function()? locationProvider;
  const RiderHome({
    super.key,
    required this.name,
    required this.onLogout,
    this.locationProvider,
  });
  @override
  State<RiderHome> createState() => _RiderHomeState();
}

class _RiderHomeState extends State<RiderHome> with Polling {
  Map shift = {'onShift': false};
  List<dynamic> orders = [];
  Map? summary;
  Set<String>? seen;
  Timer? _gpsTimer;
  Timer? _countdownTimer;
  DateTime _now = DateTime.now();

  @override
  void initState() {
    super.initState();
    startPolling();
  }

  @override
  void dispose() {
    _gpsTimer?.cancel();
    _countdownTimer?.cancel();
    super.dispose();
  }

  String get status => shift['onShift'] == true ? shift['status'] as String : 'OFF';

  void _syncTimers() {
    if (status == 'DELIVERING' && orders.isNotEmpty) {
      if (_gpsTimer == null) {
        _sendGps();
        _gpsTimer = Timer.periodic(const Duration(seconds: 15), (_) => _sendGps());
      }
    } else {
      _gpsTimer?.cancel();
      _gpsTimer = null;
    }

    final hasUnreachable = orders.any((o) => o['unreachableStartedAt'] != null && o['status'] == 'ON_THE_WAY');
    if (hasUnreachable) {
      _countdownTimer ??= Timer.periodic(const Duration(seconds: 1), (_) {
        if (mounted) setState(() => _now = DateTime.now());
      });
    } else {
      _countdownTimer?.cancel();
      _countdownTimer = null;
    }
  }

  Future<void> _sendGps() async {
    if (status != 'DELIVERING' || orders.isEmpty) {
      _gpsTimer?.cancel();
      _gpsTimer = null;
      return;
    }
    try {
      Map<String, double>? coords =
          widget.locationProvider != null ? await widget.locationProvider!() : null;
      if (coords == null) {
        final first = orders.first as Map;
        final lat = (first['destLat'] as num?)?.toDouble() ?? 40.4168;
        final lng = (first['destLng'] as num?)?.toDouble() ?? -3.7038;
        coords = {'lat': lat, 'lng': lng};
      }
      await Api.patch('/staff/riders/me/location', {
        'lat': coords['lat'],
        'lng': coords['lng'],
      });
    } catch (_) {}
  }

  @override
  Future<void> refresh() async {
    try {
      final s = await Api.get('/me/shift') as Map;
      final o = await Api.get('/orders') as List<dynamic>;
      Map? sum;
      if (s['onShift'] == true) sum = await Api.get('/me/summary') as Map;
      // Sound when a new order is assigned to me
      if (seen != null && o.any((x) => !seen!.contains(x['id']))) alertSound();
      seen = o.map((x) => x['id'] as String).toSet();
      if (mounted) {
        setState(() {
          shift = s;
          orders = o;
          summary = sum;
          _now = DateTime.now();
        });
        _syncTimers();
      }
    } catch (_) {}
  }

  Future<void> _markUnreachable(Map o) async {
    try {
      await Api.post('/orders/${o['id']}/unreachable');
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _returnToStore(Map o) async {
    final ok = await confirm(context, tr('returnStoreBtn'), '#${o['number']} · ${o['clientName']}');
    if (!ok) return;
    try {
      await Api.post('/orders/${o['id']}/unreachable-return');
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _ready() async {
    try {
      await Api.post('/me/ready');
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  /// Confirmation screen before marking an order as delivered (shows the cash to collect).
  Future<void> _delivered(Map o) async {
    final cash = o['paymentMethod'] == 'CASH' ? '\n${tr('collect')}: ${eur(o['total'])}\n${payLine(o)}' : '';
    final ok = await confirm(context, tr('confirmTitle'), '${tr('confirmBody')} #${o['number']}?$cash');
    if (!ok) return;
    try {
      await Api.post('/orders/${o['id']}/delivered');
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _editAddress(Map o) async {
    var streetType = (o['streetType'] ?? 'calle').toString();
    const types = ['calle', 'avenida', 'plaza', 'paseo', 'camino', 'carretera'];
    if (!types.contains(streetType)) streetType = 'calle';
    final keys = ['streetName', 'streetNumber', 'postalCode', 'floor', 'door'];
    final labels = ['streetName', 'streetNumber', 'postalCode', 'floorLbl', 'doorLbl'];
    final ctl = {for (final k in keys) k: TextEditingController(text: (o[k] ?? '').toString())};
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => StatefulBuilder(
        builder: (d, setDialogState) => AlertDialog(
          title: Text(tr('edit')),
          content: SingleChildScrollView(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              DropdownButtonFormField<String>(
                value: streetType,
                decoration: InputDecoration(labelText: tr('streetType')),
                items: [for (final v in types) DropdownMenuItem(value: v, child: Text(v))],
                onChanged: (v) => setDialogState(() => streetType = v ?? 'calle'),
              ),
              for (var i = 0; i < keys.length; i++)
                TextField(controller: ctl[keys[i]], decoration: InputDecoration(labelText: tr(labels[i]))),
            ]),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(d, false), child: Text(tr('no'))),
            FilledButton(onPressed: () => Navigator.pop(d, true), child: Text(tr('save'))),
          ],
        ),
      ),
    );
    if (ok != true) return;
    try {
      await Api.patch('/orders/${o['id']}/address', {
        'streetType': streetType,
        for (final k in keys) k: ctl[k]!.text.trim(),
      });
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _copy(String text) async {
    await Clipboard.setData(ClipboardData(text: text));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${tr('copied')}: $text'), duration: const Duration(seconds: 2)),
      );
    }
  }

  Future<void> _open(String url) async {
    await launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication);
  }

  Future<void> _setLang(String l) async {
    appLang.value = l;
    final p = await SharedPreferences.getInstance();
    await p.setString('lang', l);
    try {
      await Api.post('/me/language', {'language': l}); // push notifications use this language
    } catch (_) {}
  }

  Color _statusColor(BuildContext c) {
    switch (status) {
      case 'AVAILABLE':
        return Colors.green.shade100;
      case 'DELIVERING':
        return Colors.orange.shade100;
      case 'COMING_BACK':
        return Colors.blue.shade100;
      case 'SETTLING':
        return Colors.amber.shade100;
      default:
        return Colors.grey.shade300;
    }
  }

  Widget _orderCard(Map o) {
    final address = addressLine(o);
    final mapAddress = '${o['streetType']} ${o['streetName']} ${o['streetNumber']}, ${o['postalCode']}';
    final itemsLines = ((o['items'] as List?) ?? []).map((i) {
      final mods = ((i['modifiers'] as List?) ?? []).cast<Map>();
      final modStr = mods.isEmpty ? '' : '\n   + ${mods.map((m) => m['optionName']).join(', ')}';
      return '${i['quantity']}× ${i['name']}$modStr';
    }).join('\n');

    final unreachRaw = o['unreachableStartedAt'];
    int? remainingSec;
    if (unreachRaw != null) {
      final started = DateTime.tryParse(unreachRaw.toString());
      final elapsed = started != null ? _now.difference(started).inSeconds : 0;
      remainingSec = (300 - elapsed).clamp(0, 300).toInt();
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${tr('stop')} ${o['stopNumber']} · #${o['number']} · ${o['clientName']}',
              style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 4),
          InkWell(
            onTap: () => _copy(address),
            child: Row(children: [
              Expanded(child: SelectableText(address)),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.copy, size: 16),
                tooltip: tr('copy'),
                onPressed: () => _copy(address),
              ),
            ]),
          ),
          InkWell(
            onTap: () => _copy(o['clientPhone'].toString()),
            child: Row(children: [
              Expanded(child: SelectableText('Tel: ${o['clientPhone']}')),
              IconButton(
                visualDensity: VisualDensity.compact,
                icon: const Icon(Icons.copy, size: 16),
                tooltip: tr('copy'),
                onPressed: () => _copy(o['clientPhone'].toString()),
              ),
            ]),
          ),
          if (itemsLines.isNotEmpty) Text(itemsLines),
          Text('${tr('total')} ${eur(o['total'])} · ${payLine(o)}', style: const TextStyle(fontWeight: FontWeight.w600)),
          if ((o['notes'] ?? '').toString().isNotEmpty)
            Text('${tr('notes')}: ${o['notes']}', style: const TextStyle(fontStyle: FontStyle.italic)),
          if (remainingSec != null) ...[
            const SizedBox(height: 6),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: Colors.orange.shade50,
                border: Border.all(color: Colors.orange.shade300),
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                '⏱ ${tr('wait5Min')} · ${(remainingSec ~/ 60).toString().padLeft(2, '0')}:${(remainingSec % 60).toString().padLeft(2, '0')}',
                style: const TextStyle(color: Colors.deepOrange, fontWeight: FontWeight.bold),
              ),
            ),
          ],
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            OutlinedButton.icon(
              icon: const Icon(Icons.map),
              label: Text(tr('map')),
              onPressed: () {
                _copy(mapAddress);
                _open('https://www.google.com/maps/search/?api=1&query=${Uri.encodeComponent(mapAddress)}');
              },
            ),
            OutlinedButton.icon(
              icon: const Icon(Icons.call),
              label: Text(tr('call')),
              onPressed: () => _open('tel:${o['clientPhone']}'),
            ),
            OutlinedButton.icon(icon: const Icon(Icons.edit), label: Text(tr('edit')), onPressed: () => _editAddress(o)),
            OutlinedButton.icon(
              icon: const Icon(Icons.chat_bubble_outline),
              label: Text(tr('chatClient')),
              onPressed: () => openChatSheet(
                context,
                title: '${tr('chatClient')} · #${o['number']} ${o['clientName']}',
                endpoint: '/orders/${o['id']}/messages',
                myRole: 'REPARTIDOR',
              ),
            ),
            if (remainingSec == null)
              OutlinedButton.icon(
                icon: const Icon(Icons.timer_outlined),
                label: Text(tr('unreachableBtn')),
                onPressed: () => _markUnreachable(o),
              ),
          ]),
          if (remainingSec == 0) ...[
            const SizedBox(height: 8),
            SizedBox(
              width: double.infinity,
              child: FilledButton.tonalIcon(
                icon: const Icon(Icons.assignment_return_outlined),
                label: Text(tr('returnStoreBtn')),
                onPressed: () => _returnToStore(o),
              ),
            ),
          ],
          const SizedBox(height: 8),
          SizedBox(
            width: double.infinity,
            child: FilledButton(onPressed: () => _delivered(o), child: Text(tr('delivered'))),
          ),
        ]),
      ),
    );
  }

  Widget _summary() {
    final s = summary;
    if (s == null) return const SizedBox.shrink();
    final cards = (s['cardPayments'] as List).cast<Map>();
    return Card(
      child: ExpansionTile(
        title: Text(tr('myShift')),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('${tr('deliveries')}: ${s['deliveries']}'),
          Text('${tr('cashCollected')}: ${eur(s['cashCollected'])}'),
          Text('${tr('changeGiven')}: ${eur(s['changeGiven'])}'),
          Text('${tr('cashDue')}: ${eur(s['cashDue'])}', style: const TextStyle(fontWeight: FontWeight.bold)),
          const SizedBox(height: 8),
          // Card payments: one line each, never summed (match them with the card terminal tickets)
          Text('${tr('cardPayments')}: ${cards.length}'),
          for (final c in cards) Text('   #${c['orderNumber']} — ${eur(c['amount'])}'),
        ],
      ),
    );
  }

  Widget _history() {
    final s = summary;
    if (s == null) return const SizedBox.shrink();
    final hist = ((s['history'] ?? const []) as List).cast<Map>();
    return Card(
      child: ExpansionTile(
        initiallyExpanded: true,
        title: Text('${tr('history')} (${hist.length})'),
        childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (hist.isEmpty) Text(tr('noHistory')),
          for (final h in hist)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 6),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                  '#${h['number']} · ${h['clientName']}${h['deliveredAt'] != null ? ' · ${hhmm(h['deliveredAt'] as String)}' : ''}',
                  style: const TextStyle(fontWeight: FontWeight.bold),
                ),
                Text(addressLine(h)),
                Text('${tr('total')} ${eur(h['total'])} · ${payLine(h)}'),
              ]),
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String>(
        valueListenable: appLang,
        builder: (context, _, __) => Scaffold(
          appBar: AppBar(
            title: Text(widget.name),
            actions: [
              IconButton(
                icon: const Icon(Icons.chat_bubble_outline),
                tooltip: tr('chatJefe'),
                onPressed: () => openChatSheet(
                  context,
                  title: tr('chatJefe'),
                  endpoint: '/chat/staff/me',
                  myRole: 'REPARTIDOR',
                ),
              ),
              IconButton(
                icon: const Icon(Icons.star_outline),
                tooltip: tr('ratings'),
                onPressed: () => Navigator.push(context, MaterialPageRoute(builder: (_) => const RatingsScreen())),
              ),
              PopupMenuButton<String>(
                onSelected: (v) => v == 'logout' ? widget.onLogout() : _setLang(v),
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'es', child: Text('Español')),
                  const PopupMenuItem(value: 'en', child: Text('English')),
                  PopupMenuItem(value: 'logout', child: Text(tr('logout'))),
                ],
              ),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: refresh,
            child: ListView(padding: const EdgeInsets.all(12), children: [
              Card(
                color: _statusColor(context),
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(tr('status.$status'), style: Theme.of(context).textTheme.titleLarge),
                    if (status == 'DELIVERING') ...[
                      const SizedBox(height: 4),
                      Text(
                        '📍 ${tr('gpsActive')}',
                        style: const TextStyle(fontWeight: FontWeight.w600, color: Colors.black87),
                      ),
                    ],
                  ]),
                ),
              ),
              // Only visible while coming back to the restaurant
              if (status == 'COMING_BACK')
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: SizedBox(
                    height: 72,
                    child: FilledButton(
                      onPressed: _ready,
                      child: Text(tr('readyBtn'), style: const TextStyle(fontSize: 20)),
                    ),
                  ),
                ),
              if (status == 'OFF')
                Padding(padding: const EdgeInsets.all(24), child: Text(tr('noShift'), textAlign: TextAlign.center)),
              if (status != 'OFF') ...[
                const SizedBox(height: 8),
                Text(tr('myOrders'), style: Theme.of(context).textTheme.titleMedium),
                if (orders.isEmpty) Padding(padding: const EdgeInsets.all(16), child: Text(tr('noOrders'))),
                for (final o in orders.cast<Map>()) _orderCard(o),
                _summary(),
                _history(),
              ],
            ]),
          ),
        ),
      );
}

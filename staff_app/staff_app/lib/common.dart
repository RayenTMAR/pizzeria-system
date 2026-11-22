import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'api.dart';
import 'l10n.dart';
import 'push.dart';

num n(dynamic v) => v == null ? 0 : (v is num ? v : num.parse(v.toString()));
String eur(dynamic v) => '${n(v).toStringAsFixed(2)} €';

String hhmm(String iso) {
  final t = DateTime.parse(iso).toLocal();
  return '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';
}

String addressLine(Map o) {
  final extra = <String>[
    if ((o['floor'] ?? '').toString().isNotEmpty) '${tr('floor')} ${o['floor']}',
    if ((o['door'] ?? '').toString().isNotEmpty) '${tr('door')} ${o['door']}',
  ];
  return '${o['streetType']} ${o['streetName']} ${o['streetNumber']}'
      '${extra.isEmpty ? '' : ', ${extra.join(' ')}'} (${o['postalCode']})';
}

/// Payment line. For cash it shows what the client pays with and the change to prepare.
String payLine(Map o) {
  if (o['paymentMethod'] == 'CARD') return tr('payCard');
  final cash = o['cashAmount'];
  if (cash == null) return tr('payCash');
  final change = n(cash) - n(o['total']);
  return '${tr('payCash')} · ${tr('paysWith')} ${eur(cash)} · ${tr('giveChange')} ${eur(change)}';
}

String riderStatusEs(String s, int active) {
  switch (s) {
    case 'AVAILABLE':
      return 'disponible';
    case 'DELIVERING':
      return 'repartiendo ($active)';
    case 'COMING_BACK':
      return 'volviendo';
    default:
      return 'fuera de turno';
  }
}

void showError(BuildContext c, Object e) {
  final code = e is ApiException ? e.code : 'NETWORK';
  final msg = tr('err.$code');
  ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(msg == 'err.$code' ? code : msg)));
}

/// Sound + vibration for new orders / new assignments.
/// (Push notifications are not in the MVP: the app plays this while it is open.)
void alertSound() {
  SystemSound.play(SystemSoundType.alert);
  HapticFeedback.heavyImpact();
}

Future<bool> confirm(BuildContext c, String title, String body) async {
  final r = await showDialog<bool>(
    context: c,
    builder: (d) => AlertDialog(
      title: Text(title),
      content: Text(body),
      actions: [
        TextButton(onPressed: () => Navigator.pop(d, false), child: Text(tr('no'))),
        FilledButton(onPressed: () => Navigator.pop(d, true), child: Text(tr('yes'))),
      ],
    ),
  );
  return r ?? false;
}

/// Refreshes every 5 seconds (live updates over WebSockets come later).
mixin Polling<T extends StatefulWidget> on State<T> {
  Timer? _timer;
  Future<void> refresh();
  void _onPush() => refresh();

  void startPolling() {
    refresh();
    _timer = Timer.periodic(const Duration(seconds: 5), (_) => refresh());
    pushTick.addListener(_onPush); // a push arrived while the app is open: refresh now
  }

  @override
  void dispose() {
    _timer?.cancel();
    pushTick.removeListener(_onPush);
    super.dispose();
  }
}

Future<void> openChatSheet(
  BuildContext context, {
  required String title,
  required String endpoint,
  required String myRole,
}) async {
  await showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (_) => _ChatSheet(title: title, endpoint: endpoint, myRole: myRole),
  );
}

class _ChatSheet extends StatefulWidget {
  final String title;
  final String endpoint;
  final String myRole;
  const _ChatSheet({required this.title, required this.endpoint, required this.myRole});
  @override
  State<_ChatSheet> createState() => _ChatSheetState();
}

class _ChatSheetState extends State<_ChatSheet> with Polling {
  List<dynamic> messages = [];
  Set<String>? seenIds;
  final ctl = TextEditingController();
  bool sending = false;

  @override
  void initState() {
    super.initState();
    startPolling();
  }

  @override
  void dispose() {
    ctl.dispose();
    super.dispose();
  }

  @override
  Future<void> refresh() async {
    try {
      final d = await Api.get(widget.endpoint) as List<dynamic>;
      final incoming = d.where((m) => m['senderRole'] != widget.myRole).toList();
      if (seenIds != null && incoming.any((m) => !seenIds!.contains(m['id']))) {
        alertSound();
      }
      seenIds = incoming.map((m) => m['id'] as String).toSet();
      if (mounted) setState(() => messages = d);
    } catch (_) {}
  }

  Future<void> _send() async {
    final text = ctl.text.trim();
    if (text.isEmpty || sending) return;
    setState(() => sending = true);
    try {
      await Api.post(widget.endpoint, {'text': text});
      ctl.clear();
      await refresh();
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  @override
  Widget build(BuildContext context) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: SizedBox(
          height: 420,
          child: Column(children: [
            ListTile(
              title: Text(widget.title, style: const TextStyle(fontWeight: FontWeight.bold)),
              trailing: IconButton(icon: const Icon(Icons.close), onPressed: () => Navigator.pop(context)),
            ),
            const Divider(height: 1),
            Expanded(
              child: messages.isEmpty
                  ? Center(child: Text(tr('chatEmpty')))
                  : ListView(
                      padding: const EdgeInsets.all(12),
                      children: [
                        for (final m in messages.cast<Map>())
                          Align(
                            alignment: m['senderRole'] == widget.myRole ? Alignment.centerRight : Alignment.centerLeft,
                            child: Container(
                              margin: const EdgeInsets.symmetric(vertical: 4),
                              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                              decoration: BoxDecoration(
                                color: m['senderRole'] == widget.myRole
                                    ? Theme.of(context).colorScheme.primaryContainer
                                    : Theme.of(context).colorScheme.surfaceContainerHighest,
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                                Text(
                                  '${m['senderName']} · ${hhmm(m['createdAt'] as String)}',
                                  style: Theme.of(context).textTheme.labelSmall,
                                ),
                                const SizedBox(height: 2),
                                Text(m['text'] as String),
                              ]),
                            ),
                          ),
                      ],
                    ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.all(8),
              child: Row(children: [
                Expanded(
                  child: TextField(
                    controller: ctl,
                    onSubmitted: (_) => _send(),
                    decoration: InputDecoration(
                      hintText: tr('chatHint'),
                      isDense: true,
                      border: const OutlineInputBorder(),
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(onPressed: sending ? null : _send, child: Text(tr('send'))),
              ]),
            ),
          ]),
        ),
      );
}

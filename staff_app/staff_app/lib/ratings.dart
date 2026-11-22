import 'package:flutter/material.dart';
import 'api.dart';
import 'common.dart';
import 'l10n.dart';

/// Client ratings (score + comment). Visible to all staff: jefe tab and repartidor screen.
class RatingsView extends StatefulWidget {
  const RatingsView({super.key});
  @override
  State<RatingsView> createState() => _RatingsViewState();
}

class _RatingsViewState extends State<RatingsView> {
  Map? data;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final d = await Api.get('/ratings') as Map;
      if (mounted) setState(() => data = d);
    } catch (e) {
      if (mounted) showError(context, e);
    }
  }

  String _stars(int s) => '★' * s + '☆' * (5 - s);

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String>(
        valueListenable: appLang,
        builder: (context, _, __) {
          final d = data;
          if (d == null) return const Center(child: CircularProgressIndicator());
          final list = (d['ratings'] as List).cast<Map>();
          final avg = d['average'] == null ? null : n(d['average']).toStringAsFixed(1);
          return RefreshIndicator(
            onRefresh: _load,
            child: ListView(padding: const EdgeInsets.all(12), children: [
              if (avg != null)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Text('★ $avg  (${d['count']})', style: Theme.of(context).textTheme.headlineSmall),
                ),
              if (list.isEmpty) Padding(padding: const EdgeInsets.all(32), child: Center(child: Text(tr('noRatings')))),
              for (final r in list)
                Card(
                  child: ListTile(
                    title: Text(_stars(r['score'] as int), style: const TextStyle(color: Colors.amber, fontSize: 18)),
                    subtitle: Text([
                      if ((r['comment'] ?? '').toString().isNotEmpty) r['comment'],
                      '#${r['orderNumber']}${r['repartidor'] != null ? ' · ${tr('rider')}: ${r['repartidor']}' : ''} · ${hhmm(r['createdAt'] as String)}',
                    ].join('\n')),
                    isThreeLine: (r['comment'] ?? '').toString().isNotEmpty,
                  ),
                ),
            ]),
          );
        },
      );
}

class RatingsScreen extends StatelessWidget {
  const RatingsScreen({super.key});
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: Text(tr('ratings'))),
        body: const RatingsView(),
      );
}

import 'package:flutter/material.dart';
import '../api.dart';
import '../common.dart';

/// Phone order typed in by the jefe (same structured client & address form as the website).
class ManualOrderScreen extends StatefulWidget {
  const ManualOrderScreen({super.key});
  @override
  State<ManualOrderScreen> createState() => _ManualOrderScreenState();
}

class _ManualOrderScreenState extends State<ManualOrderScreen> {
  List<dynamic> cats = [];
  final qty = <String, int>{};
  final c = {
    for (final k in ['name', 'phone', 'street', 'number', 'postal', 'floor', 'door', 'notes', 'cash'])
      k: TextEditingController()
  };
  String type = 'calle';
  String pay = 'CARD';
  bool busy = false;

  @override
  void initState() {
    super.initState();
    Api.get('/menu').then((m) {
      if (mounted) setState(() => cats = m as List<dynamic>);
    }).catchError((e) {
      if (mounted) showError(context, e);
    });
  }

  @override
  void dispose() {
    for (final ctl in c.values) {
      ctl.dispose();
    }
    super.dispose();
  }

  String t(String k) => c[k]!.text.trim();

  Map<String, Map> get _productsById => {
        for (final cat in cats.cast<Map>())
          for (final p in (cat['products'] as List).cast<Map>()) p['id'] as String: p,
      };

  int get _count => qty.values.fold(0, (s, q) => s + (q > 0 ? q : 0));

  num get _total {
    final map = _productsById;
    num sum = 0;
    for (final e in qty.entries) {
      if (e.value > 0 && map[e.key] != null) {
        sum += n(map[e.key]!['price']) * e.value;
      }
    }
    return sum;
  }

  Future<void> _submit() async {
    final items = [
      for (final e in qty.entries)
        if (e.value > 0) {'productId': e.key, 'quantity': e.value}
    ];
    if (items.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Añade al menos un producto.')));
      return;
    }
    if (t('name').isEmpty || t('phone').length < 6) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Indica el nombre y un teléfono válido.')));
      return;
    }
    if (t('street').isEmpty || t('number').isEmpty || !RegExp(r'^\d{5}$').hasMatch(t('postal'))) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Revisa la dirección y el código postal (5 cifras).')),
      );
      return;
    }
    final cash = double.tryParse(t('cash').replaceAll(',', '.'));
    if (pay == 'CASH' && cash != null && cash < _total) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('El importe con el que paga es menor que el total.')),
      );
      return;
    }
    setState(() => busy = true);
    try {
      await Api.post('/orders', {
        'clientName': t('name'),
        'clientPhone': t('phone'),
        'streetType': type,
        'streetName': t('street'),
        'streetNumber': t('number'),
        'postalCode': t('postal'),
        if (t('floor').isNotEmpty) 'floor': t('floor'),
        if (t('door').isNotEmpty) 'door': t('door'),
        if (t('notes').isNotEmpty) 'notes': t('notes'),
        'paymentMethod': pay,
        if (pay == 'CASH' && cash != null) 'cashAmount': cash,
        'items': items,
      });
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  Widget _field(
    String k,
    String label, {
    TextInputType? kb,
    String? hint,
    int maxLines = 1,
    int? maxLength,
  }) =>
      TextField(
        controller: c[k],
        keyboardType: kb,
        maxLines: maxLines,
        maxLength: maxLength,
        decoration: InputDecoration(
          labelText: label,
          hintText: hint,
          counterText: '',
          isDense: true,
          border: const OutlineInputBorder(),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final total = _total;
    final count = _count;
    return Scaffold(
      appBar: AppBar(title: const Text('Pedido manual')),
      bottomNavigationBar: SafeArea(
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            border: Border(top: BorderSide(color: Theme.of(context).dividerColor)),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  '$count ${count == 1 ? 'producto' : 'productos'} · ${eur(total)}',
                  style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16),
                ),
              ),
              FilledButton(
                onPressed: busy ? null : _submit,
                child: Text(busy ? 'Enviando…' : 'Hacer pedido'),
              ),
            ],
          ),
        ),
      ),
      body: ListView(padding: const EdgeInsets.all(12), children: [
        for (final cat in cats.cast<Map>()) ...[
          Padding(
            padding: const EdgeInsets.only(top: 8, bottom: 4),
            child: Text(cat['name'] as String, style: Theme.of(context).textTheme.titleMedium),
          ),
          for (final p in (cat['products'] as List).cast<Map>())
            Card(
              child: ListTile(
                dense: true,
                title: Text('${p['name']} · ${eur(p['price'])}', style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: (p['description'] ?? '').toString().isNotEmpty ? Text(p['description'] as String) : null,
                trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                  if ((qty[p['id']] ?? 0) > 0) ...[
                    IconButton(
                      icon: const Icon(Icons.remove_circle_outline),
                      onPressed: () => setState(() => qty[p['id'] as String] = ((qty[p['id']] ?? 0) - 1).clamp(0, 50).toInt()),
                    ),
                    Text('${qty[p['id']] ?? 0}', style: const TextStyle(fontWeight: FontWeight.bold)),
                  ],
                  IconButton(
                    icon: const Icon(Icons.add_circle_outline),
                    onPressed: () => setState(() => qty[p['id'] as String] = ((qty[p['id']] ?? 0) + 1).clamp(0, 50).toInt()),
                  ),
                ]),
              ),
            ),
        ],
        const SizedBox(height: 12),
        Text('Datos del cliente', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(children: [
              _field('name', 'Nombre'),
              const SizedBox(height: 10),
              _field('phone', 'Teléfono', kb: TextInputType.phone),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        Text('Dirección de entrega', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Column(children: [
              Row(children: [
                Expanded(
                  child: DropdownButtonFormField<String>(
                    value: type,
                    isDense: true,
                    decoration: const InputDecoration(labelText: 'Tipo de vía', border: OutlineInputBorder()),
                    items: [
                      for (final v in ['calle', 'avenida', 'plaza', 'paseo', 'camino', 'carretera'])
                        DropdownMenuItem(value: v, child: Text(v))
                    ],
                    onChanged: (v) => setState(() => type = v ?? 'calle'),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: _field('postal', 'Código postal', kb: TextInputType.number, maxLength: 5),
                ),
              ]),
              const SizedBox(height: 10),
              _field('street', 'Nombre de la vía'),
              const SizedBox(height: 10),
              Row(children: [
                Expanded(flex: 4, child: _field('number', 'Número')),
                const SizedBox(width: 8),
                Expanded(flex: 3, child: _field('floor', 'Planta', hint: 'opcional')),
                const SizedBox(width: 8),
                Expanded(flex: 3, child: _field('door', 'Puerta', hint: 'opcional')),
              ]),
              const SizedBox(height: 10),
              _field(
                'notes',
                'Notas para el repartidor (opcional)',
                maxLines: 2,
                maxLength: 500,
                hint: 'Ej.: llámame al llegar / no llames al timbre, hay un bebé',
              ),
            ]),
          ),
        ),
        const SizedBox(height: 12),
        Text('Pago en la entrega', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: 6),
        SegmentedButton<String>(
          segments: const [
            ButtonSegment(value: 'CARD', label: Text('Tarjeta')),
            ButtonSegment(value: 'CASH', label: Text('Efectivo')),
          ],
          selected: {pay},
          onSelectionChanged: (s) => setState(() => pay = s.first),
        ),
        if (pay == 'CASH') ...[
          const SizedBox(height: 8),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                _field(
                  'cash',
                  '¿Con cuánto va a pagar? (€)',
                  kb: const TextInputType.numberWithOptions(decimal: true),
                  hint: total > 0 ? 'Total ${eur(total)}' : null,
                ),
                const SizedBox(height: 6),
                Text(
                  'Así el repartidor lleva el cambio preparado.',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ]),
            ),
          ),
        ],
        const SizedBox(height: 16),
      ]),
    );
  }
}

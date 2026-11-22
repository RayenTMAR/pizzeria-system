import 'package:flutter/material.dart';
import '../api.dart';
import '../common.dart';

class _CartLine {
  final Map product;
  final List<Map> modifiers;
  int quantity;

  _CartLine({required this.product, required this.modifiers, this.quantity = 1});

  String get key {
    final ids = modifiers.map((m) => m['id'] as String).toList()..sort();
    return '${product['id']}::${ids.join(',')}';
  }

  num get unitPrice => n(product['price']) + modifiers.fold<num>(0, (s, m) => s + n(m['priceDelta']));
}

/// Phone order typed in by the jefe (same structured client & address form as the website).
class ManualOrderScreen extends StatefulWidget {
  const ManualOrderScreen({super.key});
  @override
  State<ManualOrderScreen> createState() => _ManualOrderScreenState();
}

class _ManualOrderScreenState extends State<ManualOrderScreen> {
  List<dynamic> cats = [];
  final List<_CartLine> cart = [];
  final c = {
    for (final k in ['name', 'phone', 'street', 'number', 'postal', 'floor', 'door', 'notes', 'cash', 'promo'])
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

  int get _count => cart.fold(0, (s, l) => s + l.quantity);

  num get _total => cart.fold<num>(0, (s, l) => s + l.unitPrice * l.quantity);

  int _productCount(String productId) =>
      cart.where((l) => l.product['id'] == productId).fold(0, (s, l) => s + l.quantity);

  void _addLine(Map product, List<Map> modifiers) {
    final candidate = _CartLine(product: product, modifiers: modifiers, quantity: 1);
    setState(() {
      final idx = cart.indexWhere((l) => l.key == candidate.key);
      if (idx >= 0) {
        cart[idx].quantity = (cart[idx].quantity + 1).clamp(1, 50).toInt();
      } else {
        cart.add(candidate);
      }
    });
  }

  void _decrementSimpleOrLast(String productId) {
    setState(() {
      final idx = cart.lastIndexWhere((l) => l.product['id'] == productId);
      if (idx < 0) return;
      if (cart[idx].quantity > 1) {
        cart[idx].quantity--;
      } else {
        cart.removeAt(idx);
      }
    });
  }

  Future<void> _onTapAddProduct(Map p) async {
    final rawGroups = ((p['modifierGroups'] as List?) ?? []).cast<Map>();
    final groups = <Map>[
      for (final g in rawGroups)
        if (g['modifierGroup'] is Map) g['modifierGroup'] as Map else g
    ];
    if (groups.isEmpty) {
      _addLine(p, const []);
      return;
    }

    final selected = <String, Set<String>>{
      for (final g in groups) g['id'] as String: <String>{},
    };
    final isCombo = p['isCombo'] == true;

    final chosen = await showDialog<List<Map>>(
      context: context,
      builder: (ctx) => StatefulBuilder(
        builder: (ctx, setD) {
          bool allValid = true;
          for (final g in groups) {
            final gid = g['id'] as String;
            final minSel = n(g['minSelections']).toInt();
            final maxSel = n(g['maxSelections']).toInt();
            final cnt = selected[gid]?.length ?? 0;
            if (cnt < minSel || (maxSel > 0 && cnt > maxSel)) {
              allValid = false;
              break;
            }
          }

          num extra = 0;
          final chosenList = <Map>[];
          for (final g in groups) {
            final gid = g['id'] as String;
            final opts = ((g['options'] as List?) ?? []).cast<Map>();
            for (final o in opts) {
              if ((selected[gid] ?? const <String>{}).contains(o['id'])) {
                extra += n(o['priceDelta']);
                chosenList.add(o);
              }
            }
          }

          return AlertDialog(
            title: Text(p['name'] as String),
            content: SizedBox(
              width: 420,
              child: SingleChildScrollView(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    for (var i = 0; i < groups.length; i++) ...[
                      Builder(builder: (_) {
                        final g = groups[i];
                        final gid = g['id'] as String;
                        final minSel = n(g['minSelections']).toInt();
                        final maxSel = n(g['maxSelections']).toInt();
                        final opts = ((g['options'] as List?) ?? []).cast<Map>();
                        final picks = selected[gid]!;
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${isCombo ? 'Paso ${i + 1}: ' : ''}${g['name']}'
                                '${minSel > 0 ? ' (Obligatorio)' : ' (Opcional)'}'
                                '${maxSel > 1 ? ' · máx. $maxSel' : ''}',
                                style: const TextStyle(fontWeight: FontWeight.bold),
                              ),
                              const SizedBox(height: 4),
                              for (final o in opts)
                                Builder(builder: (_) {
                                  final oid = o['id'] as String;
                                  final avail = o['isAvailable'] != false;
                                  final delta = n(o['priceDelta']);
                                  final deltaTxt = delta > 0 ? ' (+${eur(delta)})' : '';
                                  final label = avail ? '${o['name']}$deltaTxt' : '${o['name']} (Agotado)';
                                  final isChecked = picks.contains(oid);
                                  if (maxSel == 1) {
                                    return RadioListTile<String>(
                                      dense: true,
                                      contentPadding: EdgeInsets.zero,
                                      value: oid,
                                      groupValue: picks.isNotEmpty ? picks.first : null,
                                      title: Text(label),
                                      onChanged: !avail
                                          ? null
                                          : (v) => setD(() {
                                                if (v == null) return;
                                                if (isChecked && minSel == 0) {
                                                  picks.clear();
                                                } else {
                                                  picks
                                                    ..clear()
                                                    ..add(v);
                                                }
                                              }),
                                    );
                                  }
                                  return CheckboxListTile(
                                    dense: true,
                                    contentPadding: EdgeInsets.zero,
                                    controlAffinity: ListTileControlAffinity.leading,
                                    value: isChecked,
                                    title: Text(label),
                                    onChanged: !avail
                                        ? null
                                        : (v) => setD(() {
                                              if (v == true) {
                                                if (maxSel <= 0 || picks.length < maxSel) {
                                                  picks.add(oid);
                                                }
                                              } else {
                                                picks.remove(oid);
                                              }
                                            }),
                                  );
                                }),
                            ],
                          ),
                        );
                      }),
                    ],
                  ],
                ),
              ),
            ),
            actions: [
              TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancelar')),
              FilledButton(
                onPressed: allValid ? () => Navigator.pop(ctx, chosenList) : null,
                child: Text('Añadir · ${eur(n(p['price']) + extra)}'),
              ),
            ],
          );
        },
      ),
    );

    if (chosen != null) {
      _addLine(p, chosen);
    }
  }

  Future<void> _submit() async {
    final items = [
      for (final line in cart)
        if (line.quantity > 0)
          {
            'productId': line.product['id'],
            'quantity': line.quantity,
            if (line.modifiers.isNotEmpty)
              'selectedModifiers': [
                for (final m in line.modifiers) {'modifierOptionId': m['id']}
              ],
          }
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
        if (t('promo').isNotEmpty) 'promoCode': t('promo').toUpperCase(),
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
            Builder(builder: (_) {
              final pid = p['id'] as String;
              final cnt = _productCount(pid);
              final allergens = ((p['allergens'] as List?) ?? []).cast<String>();
              final desc = (p['description'] ?? '').toString();
              final hasGroups = ((p['modifierGroups'] as List?) ?? []).isNotEmpty;
              final subParts = <String>[
                if (desc.isNotEmpty) desc,
                if (hasGroups) 'Con opciones personalizables',
                if (allergens.isNotEmpty) 'Alérgenos: ${allergens.join(', ')}',
              ];
              return Card(
                child: ListTile(
                  dense: true,
                  title: Row(children: [
                    Flexible(
                      child: Text(
                        '${p['name']} · ${eur(p['price'])}',
                        style: const TextStyle(fontWeight: FontWeight.w600),
                      ),
                    ),
                    if (p['isCombo'] == true) ...[
                      const SizedBox(width: 6),
                      const Chip(
                        label: Text('COMBO', style: TextStyle(fontSize: 10)),
                        visualDensity: VisualDensity.compact,
                        padding: EdgeInsets.zero,
                      ),
                    ],
                  ]),
                  subtitle: subParts.isNotEmpty ? Text(subParts.join('\n')) : null,
                  trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                    if (cnt > 0) ...[
                      IconButton(
                        icon: const Icon(Icons.remove_circle_outline),
                        onPressed: () => _decrementSimpleOrLast(pid),
                      ),
                      Text('$cnt', style: const TextStyle(fontWeight: FontWeight.bold)),
                    ],
                    IconButton(
                      icon: const Icon(Icons.add_circle_outline),
                      onPressed: () => _onTapAddProduct(p),
                    ),
                  ]),
                ),
              );
            }),
        ],
        if (cart.isNotEmpty) ...[
          const SizedBox(height: 12),
          Text('Resumen del carrito', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 6),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(8),
              child: Column(
                children: [
                  for (var i = 0; i < cart.length; i++)
                    Builder(builder: (_) {
                      final line = cart[i];
                      final modNames = line.modifiers.map((m) => '+ ${m['name']}').join(', ');
                      return ListTile(
                        dense: true,
                        title: Text('${line.quantity}x ${line.product['name']} · ${eur(line.unitPrice * line.quantity)}'),
                        subtitle: modNames.isNotEmpty ? Text(modNames) : null,
                        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
                          IconButton(
                            icon: const Icon(Icons.remove_circle_outline, size: 20),
                            onPressed: () => setState(() {
                              if (line.quantity > 1) {
                                line.quantity--;
                              } else {
                                cart.removeAt(i);
                              }
                            }),
                          ),
                          IconButton(
                            icon: const Icon(Icons.add_circle_outline, size: 20),
                            onPressed: () => setState(() => line.quantity = (line.quantity + 1).clamp(1, 50).toInt()),
                          ),
                        ]),
                      );
                    }),
                ],
              ),
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
              const SizedBox(height: 10),
              _field('promo', 'Código promocional (opcional)', hint: 'Ej.: BIENVENIDA'),
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

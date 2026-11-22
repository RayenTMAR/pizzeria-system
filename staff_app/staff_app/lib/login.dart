import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'common.dart';
import 'l10n.dart';

class LoginScreen extends StatefulWidget {
  final Future<void> Function(Map<String, dynamic>) onLogin;
  const LoginScreen({super.key, required this.onLogin});
  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final email = TextEditingController();
  final pass = TextEditingController();
  bool busy = false;

  Future<void> _setLang(String l) async {
    appLang.value = l;
    final p = await SharedPreferences.getInstance();
    await p.setString('lang', l);
  }

  Future<void> _submit() async {
    setState(() => busy = true);
    try {
      final r = await Api.post('/auth/login', {'email': email.text.trim(), 'password': pass.text});
      await widget.onLogin(Map<String, dynamic>.from(r as Map));
    } catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder<String>(
        valueListenable: appLang,
        builder: (context, lang, _) => Scaffold(
          body: SafeArea(
            child: Center(
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 380),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    Align(
                      alignment: Alignment.centerRight,
                      child: SegmentedButton<String>(
                        segments: const [
                          ButtonSegment(value: 'es', label: Text('ES')),
                          ButtonSegment(value: 'en', label: Text('EN')),
                        ],
                        selected: {lang},
                        onSelectionChanged: (s) => _setLang(s.first),
                      ),
                    ),
                    const SizedBox(height: 16),
                    const Icon(Icons.delivery_dining, size: 72),
                    const SizedBox(height: 8),
                    Text(tr('login.title'), style: Theme.of(context).textTheme.titleLarge),
                    const SizedBox(height: 24),
                    TextField(
                      controller: email,
                      keyboardType: TextInputType.emailAddress,
                      autofillHints: const [AutofillHints.email],
                      decoration: InputDecoration(labelText: tr('login.email'), border: const OutlineInputBorder()),
                    ),
                    const SizedBox(height: 12),
                    TextField(
                      controller: pass,
                      obscureText: true,
                      autofillHints: const [AutofillHints.password],
                      onSubmitted: (_) => _submit(),
                      decoration: InputDecoration(labelText: tr('login.password'), border: const OutlineInputBorder()),
                    ),
                    const SizedBox(height: 16),
                    SizedBox(
                      width: double.infinity,
                      child: FilledButton(
                        onPressed: busy ? null : _submit,
                        child: busy
                            ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2))
                            : Text(tr('login.button')),
                      ),
                    ),
                  ]),
                ),
              ),
            ),
          ),
        ),
      );
}

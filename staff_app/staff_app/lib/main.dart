import 'dart:async';
import 'dart:ui' show PlatformDispatcher;
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'api.dart';
import 'l10n.dart';
import 'login.dart';
import 'push.dart';
import 'jefe/jefe_home.dart';
import 'rider/rider_home.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  unawaited(Push.init()); // do not block the first screen on the permission dialog
  runApp(const StaffApp());
}

class StaffApp extends StatefulWidget {
  const StaffApp({super.key});
  @override
  State<StaffApp> createState() => _StaffAppState();
}

class _StaffAppState extends State<StaffApp> {
  bool loading = true;
  bool _loggingOut = false;
  String? role;
  String name = '';

  @override
  void initState() {
    super.initState();
    Api.onUnauthorized = _logout;
    _restore();
  }

  Future<void> _restore() async {
    final p = await SharedPreferences.getInstance();
    Api.token = p.getString('token');
    role = p.getString('role');
    name = p.getString('name') ?? '';
    final device = PlatformDispatcher.instance.locale.languageCode == 'en' ? 'en' : 'es';
    // The jefe side is Spanish only; everyone else uses the saved (or device) language.
    appLang.value = role == 'JEFE' ? 'es' : (p.getString('lang') ?? device);
    setState(() => loading = false);
    if (Api.token != null) unawaited(Push.register());
  }

  Future<void> _login(Map<String, dynamic> r) async {
    final p = await SharedPreferences.getInstance();
    Api.token = r['token'] as String;
    role = r['role'] as String;
    name = r['name'] as String;
    await p.setString('token', Api.token!);
    await p.setString('role', role!);
    await p.setString('name', name);
    // The language picked on the login screen is kept for repartidores.
    if (role == 'JEFE') appLang.value = 'es';
    await p.setString('lang', appLang.value);
    try {
      await Api.post('/me/language', {'language': appLang.value}); // push text language
    } catch (_) {}
    unawaited(Push.register());
    setState(() {});
  }

  Future<void> _logout() async {
    if (_loggingOut) return; // an expired token must not trigger this again
    _loggingOut = true;
    await Push.unregister();
    final p = await SharedPreferences.getInstance();
    await p.remove('token');
    await p.remove('role');
    await p.remove('name');
    Api.token = null;
    role = null;
    _loggingOut = false;
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    Widget home;
    if (loading) {
      home = const Scaffold(body: Center(child: CircularProgressIndicator()));
    } else if (Api.token == null || role == null) {
      home = LoginScreen(onLogin: _login);
    } else if (role == 'JEFE') {
      home = JefeHome(name: name, onLogout: _logout);
    } else {
      home = RiderHome(name: name, onLogout: _logout);
    }
    return MaterialApp(
      title: 'Staff',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: Colors.deepOrange, useMaterial3: true),
      home: home,
    );
  }
}

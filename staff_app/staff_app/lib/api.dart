import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'config.dart';

class ApiException implements Exception {
  final String code;
  ApiException(this.code);
  @override
  String toString() => code;
}

class Api {
  static String? token;
  static VoidCallback? onUnauthorized;

  static Future<dynamic> _send(String method, String path, [Object? body]) async {
    final uri = Uri.parse('$apiBase$path');
    final headers = {
      'Content-Type': 'application/json',
      if (token != null) 'Authorization': 'Bearer $token',
    };
    final enc = jsonEncode(body ?? {});
    try {
      late http.Response r;
      switch (method) {
        case 'POST':
          r = await http.post(uri, headers: headers, body: enc);
          break;
        case 'PATCH':
          r = await http.patch(uri, headers: headers, body: enc);
          break;
        case 'DELETE':
          r = await http.delete(uri, headers: headers);
          break;
        default:
          r = await http.get(uri, headers: headers);
      }
      final data = r.body.isEmpty ? null : jsonDecode(r.body);
      if (r.statusCode == 401 && token != null) onUnauthorized?.call();
      if (r.statusCode >= 400) {
        throw ApiException(data is Map && data['error'] != null ? data['error'].toString() : 'HTTP_${r.statusCode}');
      }
      return data;
    } on ApiException {
      rethrow;
    } catch (_) {
      throw ApiException('NETWORK');
    }
  }

  static Future<dynamic> get(String p) => _send('GET', p);
  static Future<dynamic> post(String p, [Object? b]) => _send('POST', p, b);
  static Future<dynamic> patch(String p, Object b) => _send('PATCH', p, b);
  static Future<dynamic> delete(String p) => _send('DELETE', p);
}

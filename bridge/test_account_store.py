import gc
import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from account_api import AccountAPI
from account_store import AccountConflict, AccountStore, account_id
from real_backend import Backend, ResultStore
from test_real_backend import SyntheticSource, SyntheticAnalyzer
from real_http import make_handler
from http.server import ThreadingHTTPServer


class AccountManagementTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'results'
        self.cache = self.root / 'cache'
        self.data.mkdir()
        self.cache.mkdir()
        self.stable_keys = self.root / 'stable-keys'
        self.stable_keys.mkdir()
        self.source = SimpleNamespace(lock=threading.RLock(), current='wxid_a_abcd')
        self.source.identity = lambda: (self.source.current, self.cache / self.source.current)
        self.backend = SimpleNamespace(source=self.source, stores={}, jobs={}, recent_windows={},
                                       jobs_lock=threading.Lock())
        self.backend.pause_calls = []
        self.backend.resume_calls = []
        self.backend.shutdown_calls = []
        self.backend.pause_for_account_clear = lambda account: self.backend.pause_calls.append(account)
        self.backend.resume_after_failed_account_clear = lambda: self.backend.resume_calls.append(True)
        self.backend.shutdown = lambda: self.backend.shutdown_calls.append(True)

        def scoped():
            account, workdir = self.source.identity()
            workdir.mkdir(exist_ok=True)
            scope = (account, str(workdir))
            if scope not in self.backend.stores:
                self.backend.stores[scope] = ResultStore(self.data / (account_id(account) + '.sqlite3'))
            return account, str(workdir), self.backend.stores[scope]

        self.backend._scoped_identity = scoped
        self.api = AccountAPI(self.backend, self.data, self.cache, self.stable_keys)

    def observe(self, account):
        self.source.current = account
        self.api.observe({'account': account, 'self': {'username': account[:-5], 'name': 'Same nickname'}})
        return self.data / (account_id(account) + '.sqlite3')

    def test_two_accounts_reuse_and_delete_only_inactive_derived_files(self):
        a, b = 'wxid_a_abcd', 'wxid_b_efgh'
        result_a = self.observe(a)
        stamp = result_a.stat().st_mtime_ns
        result_b = self.observe(b)
        self.observe(a)
        self.assertEqual(result_a.stat().st_mtime_ns, stamp)
        before = result_a.read_bytes()
        cache_b = self.cache / b
        snapshot = cache_b / 'message__message_0.db'
        snapshot.write_bytes(b'synthetic derived database')
        key_file = cache_b / 'keys.json'
        key_file.write_text('synthetic cached key')
        stable_b = self.stable_keys / (b + '.json')
        stable_b.write_text('synthetic stable key')
        stable_a = self.stable_keys / (a + '.json')
        stable_a.write_text('other account key')
        source = self.root / 'wechat-original.db'
        source.write_bytes(b'synthetic original')
        sidecar = Path(str(result_b) + '-journal')
        sidecar.write_bytes(b'synthetic rollback sidecar')
        enabled = gc.isenabled()
        gc.disable()
        try:
            listed = self.api.list()
            self.assertEqual(len(listed['accounts']), 2)
            self.assertEqual(sum(row['current'] for row in listed['accounts']), 1)
            self.assertEqual(self.api.delete(account_id(b)),
                             {'deleted': account_id(b), 'current': False, 'exitApp': False})
        finally:
            if enabled:
                gc.enable()
        self.assertFalse(result_b.exists())
        self.assertFalse(snapshot.exists())
        self.assertFalse(sidecar.exists())
        self.assertEqual(result_a.read_bytes(), before)
        self.assertFalse(key_file.exists())
        self.assertFalse(stable_b.exists())
        self.assertEqual(stable_a.read_text(), 'other account key')
        self.assertTrue(source.exists())
        self.assertEqual(self.backend.shutdown_calls, [])
        self.assertFalse(self.api.no_recovery_marker.exists())
        self.assertEqual(len(self.api.list()['accounts']), 1)

    def test_current_account_waits_for_stop_then_clears_only_its_files(self):
        a, b = 'wxid_a_abcd', 'wxid_b_efgh'
        a_path = self.observe(a)
        b_path = self.observe(b)
        self.observe(a)
        snapshot_a = self.cache / a / 'message__message_0.db'
        snapshot_a.write_bytes(b'current derived snapshot')
        stable_a = self.stable_keys / (a + '.json')
        stable_a.write_text('current cached key')
        original = self.root / 'wechat-original.db'
        original.write_bytes(b'original untouched')
        before_b = b_path.read_bytes()
        entered = threading.Event()
        release = threading.Event()
        outcomes = []

        def stopped(account):
            self.backend.pause_calls.append(account)
            entered.set()
            self.assertTrue(release.wait(5))

        self.backend.pause_for_account_clear = stopped
        worker = threading.Thread(target=lambda: outcomes.append(self.api.delete(account_id(a))))
        worker.start()
        try:
            self.assertTrue(entered.wait(5))
            self.assertTrue(a_path.exists())
            self.assertTrue(snapshot_a.exists())
            self.assertTrue(stable_a.exists())
            self.assertFalse(self.api.no_recovery_marker.exists())
        finally:
            release.set()
            worker.join(5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(outcomes, [{'deleted': account_id(a), 'current': True, 'exitApp': True}])
        self.assertEqual(self.backend.pause_calls, [a])
        self.assertEqual(self.backend.shutdown_calls, [True])
        self.assertFalse(a_path.exists())
        self.assertFalse(snapshot_a.exists())
        self.assertFalse(stable_a.exists())
        self.assertTrue(self.api.no_recovery_marker.exists())
        self.assertEqual(b_path.read_bytes(), before_b)
        self.assertEqual(original.read_bytes(), b'original untouched')

    def test_running_inactive_account_rejects_deletion_without_exit(self):
        a, b = 'wxid_a_abcd', 'wxid_b_efgh'
        a_path = self.observe(a)
        self.observe(b)
        self.backend.jobs[(a, 'fixture', 'conversation', 'version')] = {'status': 'running'}
        with self.assertRaises(AccountConflict):
            self.api.delete(account_id(a))
        self.assertTrue(a_path.exists())
        self.assertEqual(self.backend.shutdown_calls, [])
        self.assertFalse(self.api.no_recovery_marker.exists())

    def test_real_backend_drains_request_and_snapshot_writer_before_current_delete(self):
        account = 'wxid_a_abcd'
        self.source.current = account
        self.source.closed = False
        self.source.close = lambda: setattr(self.source, 'closed', True)
        analyzer = SyntheticAnalyzer()
        analyzer.closed = False
        analyzer.close = lambda: setattr(analyzer, 'closed', True)
        backend = Backend(self.source, analyzer,
                          lambda owned, _workdir: ResultStore(self.data / (account_id(owned) + '.sqlite3')))
        api = AccountAPI(backend, self.data, self.cache, self.stable_keys)
        api.observe({'account': account, 'self': {'username': 'wxid_a', 'name': 'Fixture'}})
        result = self.data / (account_id(account) + '.sqlite3')
        snapshot = self.cache / account / 'message__message_0.db'
        snapshot.parent.mkdir(exist_ok=True)
        snapshot.write_bytes(b'synthetic snapshot')
        lease_entered = threading.Event()
        release_lease = threading.Event()
        writer_waiting = threading.Event()
        release_writer = threading.Event()
        outcomes = []

        def held_request():
            with backend.request_lease():
                lease_entered.set()
                release_lease.wait(5)

        def wait_writer(_workdir):
            writer_waiting.set()
            return release_writer.wait(5)

        reader = threading.Thread(target=held_request)
        reader.start()
        self.assertTrue(lease_entered.wait(5))
        with patch('account_api.wait_forget_account', side_effect=wait_writer):
            deleter = threading.Thread(target=lambda: outcomes.append(api.delete(account_id(account))))
            deleter.start()
            try:
                deadline = time.monotonic() + 5
                while not backend.closing and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(backend.closing)
                self.assertTrue(result.exists())
                self.assertTrue(snapshot.exists())
                self.assertFalse(writer_waiting.is_set())
                release_lease.set()
                self.assertTrue(writer_waiting.wait(5))
                self.assertTrue(result.exists())
                self.assertTrue(snapshot.exists())
            finally:
                release_lease.set()
                release_writer.set()
                reader.join(5)
                deleter.join(5)
        self.assertFalse(reader.is_alive())
        self.assertFalse(deleter.is_alive())
        self.assertEqual(outcomes, [{'deleted': account_id(account), 'current': True, 'exitApp': True}])
        self.assertTrue(self.source.closed)
        self.assertTrue(analyzer.closed)
        self.assertFalse(backend.worker_thread.is_alive())
        self.assertFalse(result.exists())
        self.assertFalse(snapshot.exists())

    def test_failed_current_clear_resumes_bridge_without_claiming_file_rollback(self):
        a, b = 'wxid_a_abcd', 'wxid_b_efgh'
        self.source.closed = False
        self.source.close = lambda: setattr(self.source, 'closed', True)
        backend = Backend(self.source, SyntheticAnalyzer(),
                          lambda owned, _workdir: ResultStore(self.data / (account_id(owned) + '.sqlite3')))
        api = AccountAPI(backend, self.data, self.cache, self.stable_keys)
        for account in (b, a):
            self.source.current = account
            api.observe({'account': account, 'self': {'username': account, 'name': 'Fixture'}})
        result_a = self.data / (account_id(a) + '.sqlite3')
        result_b = self.data / (account_id(b) + '.sqlite3')
        before_b = result_b.read_bytes()
        original = self.root / 'wechat-original.db'
        original.write_bytes(b'synthetic original')

        def partial_failure(*_args, **_kwargs):
            result_a.unlink()
            raise OSError('synthetic file lock after one unlink')

        with patch.object(api.store, 'delete', side_effect=partial_failure):
            with self.assertRaisesRegex(OSError, 'synthetic file lock'):
                api.delete(account_id(a))
        self.assertFalse(api.no_recovery_marker.exists())
        self.assertFalse(backend.closing)
        self.assertTrue(backend.worker_thread.is_alive())
        self.assertFalse(self.source.closed)
        self.assertEqual(backend.stores, {})
        self.assertFalse(result_a.exists())  # Already removed data is not rolled back.
        self.assertEqual(result_b.read_bytes(), before_b)
        self.assertEqual(original.read_bytes(), b'synthetic original')
        with backend.request_lease():
            self.assertEqual(backend._scoped_identity()[0], a)
        self.assertTrue(result_a.exists())  # A fresh app result store can be initialized.
        backend.shutdown()

    def test_recent_window_blocks_deletion_after_main_job_finishes(self):
        a, b = 'wxid_a_abcd', 'wxid_b_efgh'
        a_path = self.observe(a)
        self.observe(b)
        key = (a, str(a_path), 'conversation', 'version')
        self.backend.jobs[key] = {'status': 'done', 'recent': {'status': 'queued'}}
        self.backend.recent_windows[key] = {'iterator': None}
        with self.assertRaisesRegex(AccountConflict, '账号分析尚未结束'):
            self.api.delete(account_id(a))
        self.assertTrue(a_path.exists())
        self.backend.recent_windows.pop(key)
        self.assertEqual(self.api.delete(account_id(a)),
                         {'deleted': account_id(a), 'current': False, 'exitApp': False})

    def test_path_escape_and_unowned_cache_are_not_deletable(self):
        self.observe('wxid_a_abcd')
        with self.assertRaises(ValueError):
            self.api.delete('../results')
        with self.assertRaises(AccountConflict):
            self.api.store.register('../outside', self.root)
        unowned = self.cache / 'unowned_abcd'
        unowned.mkdir()
        (unowned / 'message__message_0.db').write_bytes(b'not this project')
        self.assertEqual(len(self.api.list()['accounts']), 1)
        registry = json.loads(self.api.store.registry.read_text(encoding='utf-8'))
        registry['accounts'][0]['workdir'] = str(self.root)
        self.api.store.registry.write_text(json.dumps(registry), encoding='utf-8')
        self.assertFalse(any(item['workdir'] == str(self.root) for item in self.api.store._discover().values()))

    def test_local_routes_reject_foreign_origin_and_exit_after_current_clear(self):
        self.observe('wxid_a_abcd')
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.backend, self.api))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(method, path, headers=None):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
                try:
                    conn.request(method, path, headers=headers or {})
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    conn.close()
            status, body = request('GET', '/api/accounts')
            self.assertEqual(status, 200)
            target = '/api/accounts/' + body['currentAccountId']
            self.assertEqual(request('DELETE', target, {'Origin': 'https://outside.invalid'})[0], 403)
            self.assertEqual(request('DELETE', '/api/accounts/..%2f..')[0], 400)
            status, body = request('DELETE', target)
            self.assertEqual(status, 200)
            self.assertEqual(body, {'deleted': account_id('wxid_a_abcd'), 'current': True, 'exitApp': True})
            self.assertEqual(self.backend.pause_calls, ['wxid_a_abcd'])
            self.assertEqual(self.backend.shutdown_calls, [True])
            self.assertTrue(self.api.no_recovery_marker.exists())
            thread.join(3)
            self.assertFalse(thread.is_alive())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_http_inactive_clear_keeps_bridge_available(self):
        a, b = 'wxid_a_abcd', 'wxid_b_efgh'
        self.observe(b)
        self.observe(a)
        server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.backend, self.api))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            def request(method, path):
                conn = http.client.HTTPConnection('127.0.0.1', server.server_port)
                try:
                    conn.request(method, path)
                    response = conn.getresponse()
                    return response.status, json.loads(response.read())
                finally:
                    conn.close()
            status, body = request('DELETE', '/api/accounts/' + account_id(b))
            self.assertEqual(status, 200)
            self.assertEqual(body, {'deleted': account_id(b), 'current': False, 'exitApp': False})
            status, body = request('GET', '/api/accounts')
            self.assertEqual(status, 200)
            self.assertEqual(body['currentAccountId'], account_id(a))
            self.assertEqual([item['accountId'] for item in body['accounts']], [account_id(a)])
            self.assertEqual(self.backend.shutdown_calls, [])
            self.assertFalse(self.api.no_recovery_marker.exists())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()

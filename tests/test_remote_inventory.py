"""Offline regression tests for remote inventory SSH host-key policy."""

import subprocess
import unittest
from pathlib import Path
from unittest.mock import call, patch

from unified_recon import UnifiedRecon


class TestRemoteInventory(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch('unified_recon.SecureNetworkMapper'))
        self.mock_run = self.enterContext(patch('unified_recon.subprocess.run'))
        self.mock_exists = self.enterContext(
            patch('unified_recon.Path.exists', return_value=True)
        )
        mock_datetime = self.enterContext(patch('unified_recon.datetime'))
        mock_datetime.now.return_value.strftime.return_value = '1700000000'
        self.recon = UnifiedRecon(use_syn=False)
        self.target = 'inventory.lab.invalid'
        self.user = 'lab-user'
        self.remote_path = '/tmp/linux-inventory-1700000000.sh'

    def test_all_commands_require_verified_host_keys(self):
        for key in (None, 'lab-identity'):
            for stealth in (False, True):
                with self.subTest(key=key, stealth=stealth):
                    self.mock_run.reset_mock()
                    self.mock_run.side_effect = [
                        subprocess.CompletedProcess([], 0),
                        subprocess.CompletedProcess([], 0, stdout='{"host": "lab"}'),
                        subprocess.CompletedProcess([], 0),
                    ]
                    self.recon.stealth = stealth

                    result = self.recon._run_remote_inventory(
                        self.target, self.user, key
                    )

                    self.assertEqual(result, {'host': 'lab'})
                    options = ['-o', 'StrictHostKeyChecking=yes']
                    if key:
                        options.extend(['-i', key])
                    script_path = (
                        Path(__file__).resolve().parent.parent
                        / 'linux-inventory-scanner.sh'
                    )
                    destination = f'{self.user}@{self.target}'
                    command = f'bash {self.remote_path}'
                    if stealth:
                        command += ' --stealth'

                    self.assertEqual(self.mock_run.call_args_list, [
                        call(
                            ['scp', *options, str(script_path),
                             f'{destination}:{self.remote_path}'],
                            capture_output=True, timeout=30
                        ),
                        call(
                            ['ssh', *options, destination, command],
                            capture_output=True, text=True, timeout=120
                        ),
                        call(
                            ['ssh', *options, destination,
                             f'rm {self.remote_path}'],
                            capture_output=True
                        ),
                    ])

    def test_host_key_rejection_during_upload_stops_inventory(self):
        errors = (
            b'No host key is known and you have requested strict checking.',
            b'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!',
        )
        for error in errors:
            with self.subTest(error=error):
                self.mock_run.reset_mock()
                self.mock_run.return_value = subprocess.CompletedProcess(
                    [], 255, stderr=error
                )

                with self.assertLogs('unified_recon', level='ERROR'):
                    result = self.recon._run_remote_inventory(
                        self.target, self.user, None
                    )

                self.assertIsNone(result)
                self.mock_run.assert_called_once()
                command = self.mock_run.call_args.args[0]
                self.assertEqual(command[0], 'scp')
                self.assertEqual(command[1:3], ['-o', 'StrictHostKeyChecking=yes'])

    def test_host_key_rejection_during_execution_returns_no_inventory(self):
        self.mock_run.side_effect = [
            subprocess.CompletedProcess([], 0),
            subprocess.CompletedProcess(
                [], 255, stdout='', stderr='Host key verification failed.'
            ),
            subprocess.CompletedProcess([], 255),
        ]

        with self.assertLogs('unified_recon', level='ERROR'):
            result = self.recon._run_remote_inventory(
                self.target, self.user, 'lab-identity'
            )

        self.assertIsNone(result)
        self.assertEqual(self.mock_run.call_count, 3)
        for invocation in self.mock_run.call_args_list:
            command = invocation.args[0]
            self.assertEqual(command[1:3], ['-o', 'StrictHostKeyChecking=yes'])
            self.assertIn('lab-identity', command)

    def test_upload_timeout_does_not_attempt_ssh(self):
        self.mock_run.side_effect = subprocess.TimeoutExpired('scp', 30)

        with self.assertLogs('unified_recon', level='ERROR'):
            result = self.recon._run_remote_inventory(
                self.target, self.user, None
            )

        self.assertIsNone(result)
        self.mock_run.assert_called_once()
        self.assertEqual(self.mock_run.call_args.args[0][0], 'scp')

    def test_missing_inventory_script_does_not_connect(self):
        self.mock_exists.return_value = False

        with self.assertLogs('unified_recon', level='ERROR'):
            result = self.recon._run_remote_inventory(
                self.target, self.user, None
            )

        self.assertIsNone(result)
        self.mock_run.assert_not_called()


if __name__ == '__main__':
    unittest.main()

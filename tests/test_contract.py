import importlib
import json
import sys
import types
import unittest


class FakeAddress(str):
    @property
    def as_hex(self):
        return str(self)


class FakeDynArray(list):
    @classmethod
    def __class_getitem__(cls, _item):
        return cls


class FakeTreeMap(dict):
    @classmethod
    def __class_getitem__(cls, _item):
        return cls


class Decorator:
    def __call__(self, function):
        return function

    @property
    def payable(self):
        return self


class FakeBaseContract:
    pass


def passthrough(value):
    return value


def build_fake_genlayer():
    fake = types.ModuleType("genlayer")
    fake.Address = FakeAddress
    fake.DynArray = FakeDynArray
    fake.TreeMap = FakeTreeMap
    fake.u256 = int
    fake.i256 = int
    fake.allow_storage = passthrough
    fake.gl = types.SimpleNamespace(
        Contract=FakeBaseContract,
        public=types.SimpleNamespace(write=Decorator(), view=Decorator()),
        evm=types.SimpleNamespace(contract_interface=passthrough),
        vm=types.SimpleNamespace(UserError=type("UserError", (Exception,), {})),
        message=types.SimpleNamespace(value=0, sender_address=FakeAddress("0x0")),
        message_raw={"datetime": "2026-10-04T00:00:00+00:00"},
        eq_principle=types.SimpleNamespace(strict_eq=lambda function: function()),
        nondet=types.SimpleNamespace(web=types.SimpleNamespace(get=None)),
    )
    return fake


sys.modules["genlayer"] = build_fake_genlayer()
contract_module = importlib.import_module("contracts.rain_check")
gl = contract_module.gl


class FakeResponse:
    def __init__(self, payload):
        self.body = json.dumps(payload).encode("utf-8")


class FakeRecipient:
    transfers = []

    def __init__(self, address):
        self.address = address

    def emit_transfer(self, value):
        self.transfers.append((self.address, value))


contract_module._Recipient = FakeRecipient


class RainCheckContractTests(unittest.TestCase):
    def setUp(self):
        FakeRecipient.transfers = []
        self.set_context("2026-10-04T00:00:00+00:00", "0xunderwriter", 0)
        self.contract = contract_module.RainCheck()

    @staticmethod
    def set_context(when, sender, value):
        gl.message = types.SimpleNamespace(value=value, sender_address=FakeAddress(sender))
        gl.message_raw = {"datetime": when}

    def funded_contract(self):
        self.set_context("2026-10-04T00:00:00+00:00", "0xunderwriter", contract_module.MIN_RESERVE_WEI)
        self.contract.fund_reserve()

    def test_contract_version_and_owner_are_exposed(self):
        self.assertEqual(self.contract.get_contract_version(), "raincheck-v2")
        self.assertEqual(self.contract.get_owner(), FakeAddress("0xunderwriter"))

    def test_owner_can_withdraw_only_free_reserve(self):
        self.funded_contract()
        self.create_cover()
        state = self.contract.get_reserve_state()
        self.assertEqual(state["locked_payouts"], contract_module.PAYOUT_WEI)
        self.assertEqual(state["available_reserve"], 42_000_000_000_000_000)

        self.set_context("2026-10-04T00:00:00+00:00", "0xunderwriter", 0)
        with self.assertRaises(gl.vm.UserError):
            self.contract.withdraw_reserve(43_000_000_000_000_000)
        self.contract.withdraw_reserve(42_000_000_000_000_000)
        state = self.contract.get_reserve_state()
        self.assertEqual(state["available_reserve"], 0)
        self.assertEqual(state["locked_payouts"], contract_module.PAYOUT_WEI)
        self.assertEqual(FakeRecipient.transfers[-1], (FakeAddress("0xunderwriter"), 42_000_000_000_000_000))

    def test_only_owner_can_fund_or_withdraw_and_zero_withdrawals_fail(self):
        self.set_context("2026-10-04T00:00:00+00:00", "0xstranger", contract_module.MIN_RESERVE_WEI)
        with self.assertRaises(gl.vm.UserError):
            self.contract.fund_reserve()
        self.set_context("2026-10-04T00:00:00+00:00", "0xunderwriter", contract_module.MIN_RESERVE_WEI)
        self.contract.fund_reserve()
        self.contract = contract_module.RainCheck()
        self.set_context("2026-10-04T00:00:00+00:00", "0xunderwriter", contract_module.MIN_FUND_WEI - 1)
        with self.assertRaises(gl.vm.UserError):
            self.contract.fund_reserve()
        self.contract = contract_module.RainCheck()
        self.set_context("2026-10-04T00:00:00+00:00", "0xstranger", 0)
        with self.assertRaises(gl.vm.UserError):
            self.contract.withdraw_reserve(1)
        self.set_context("2026-10-04T00:00:00+00:00", "0xunderwriter", 0)
        with self.assertRaises(gl.vm.UserError):
            self.contract.withdraw_reserve(0)

    def create_cover(self):
        self.set_context("2026-10-04T00:00:00+00:00", "0xcovered-user", contract_module.PREMIUM_WEI)
        return self.contract.buy_cover(410082, 289784, "2026-10-05", 30)

    def set_weather(self, primary, corroborating):
        def get(url):
            if "archive-api.open-meteo.com" in url:
                payload = {"daily": {"precipitation_sum": [primary]}}
            else:
                payload = {"properties": {"parameter": {"PRECTOTCORR": {"20261005": corroborating}}}}
            return FakeResponse(payload)

        gl.nondet.web.get = get

    def test_reserve_and_cover_lock_the_maximum_payout(self):
        self.funded_contract()
        cover_id = self.create_cover()
        self.assertEqual(cover_id, 1)
        self.assertEqual(self.contract.get_cover_count(), 1)
        self.assertEqual(self.contract.get_available_reserve(), 42_000_000_000_000_000)

    def test_invalid_premium_and_insufficient_reserve_are_rejected(self):
        self.set_context("2026-10-04T00:00:00+00:00", "0xuser", 1)
        with self.assertRaises(gl.vm.UserError):
            self.contract.buy_cover(410082, 289784, "2026-10-05", 30)

        self.contract = contract_module.RainCheck()
        self.set_context("2026-10-04T00:00:00+00:00", "0xuser", contract_module.PREMIUM_WEI)
        with self.assertRaises(gl.vm.UserError):
            self.contract.buy_cover(410082, 289784, "2026-10-05", 30)

    def test_primary_and_corroborating_trigger_approve_a_claim(self):
        self.funded_contract()
        cover_id = self.create_cover()
        self.set_weather(34.6, 32.1)
        self.set_context("2026-10-06T00:00:00+00:00", "0xkeeper", 0)
        self.assertEqual(self.contract.resolve_claim(cover_id), "APPROVED")

    def test_rain_below_the_threshold_releases_reserved_payout(self):
        self.funded_contract()
        cover_id = self.create_cover()
        self.set_weather(20.0, 24.2)
        self.set_context("2026-10-06T00:00:00+00:00", "0xkeeper", 0)
        self.assertEqual(self.contract.resolve_claim(cover_id), "NO_TRIGGER")
        self.assertEqual(self.contract.get_available_reserve(), 52_000_000_000_000_000)

    def test_source_disagreement_pauses_payout_and_allows_premium_refund(self):
        self.funded_contract()
        cover_id = self.create_cover()
        self.set_weather(34.6, 24.2)
        self.set_context("2026-10-06T00:00:00+00:00", "0xkeeper", 0)
        self.assertEqual(self.contract.resolve_claim(cover_id), "SOURCE_REVIEW")
        self.contract.refund_source_conflict(cover_id)
        self.assertEqual(self.contract.get_cover(cover_id)["status"], "REFUNDED")
        self.assertEqual(FakeRecipient.transfers[-1], (FakeAddress("0xcovered-user"), contract_module.PREMIUM_WEI))
        self.assertEqual(self.contract.get_available_reserve(), 50_000_000_000_000_000)

    def test_missing_source_data_does_not_payout_and_can_be_retried(self):
        self.funded_contract()
        cover_id = self.create_cover()
        self.set_weather(None, 30.5)
        self.set_context("2026-10-06T00:00:00+00:00", "0xkeeper", 0)
        self.assertEqual(self.contract.resolve_claim(cover_id), "DATA_UNAVAILABLE")
        self.assertEqual(self.contract.covers[0].status, "DATA_UNAVAILABLE")

    def test_approved_cover_pays_only_once_to_its_owner(self):
        self.funded_contract()
        cover_id = self.create_cover()
        self.set_weather(34.6, 32.1)
        self.set_context("2026-10-06T00:00:00+00:00", "0xkeeper", 0)
        self.contract.resolve_claim(cover_id)
        self.contract.claim_payout(cover_id)
        self.assertEqual(self.contract.get_cover(cover_id)["status"], "PAID")
        self.assertEqual(FakeRecipient.transfers[-1], (FakeAddress("0xcovered-user"), contract_module.PAYOUT_WEI))
        with self.assertRaises(gl.vm.UserError):
            self.contract.claim_payout(cover_id)


if __name__ == "__main__":
    unittest.main()

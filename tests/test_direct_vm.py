"""GenLayer Direct Mode lifecycle test; run with `python tests/run_direct_vm.py`."""

import json


def test_cover_creation_and_two_source_settlement(direct_vm, direct_deploy, direct_alice):
    contract = direct_deploy("contracts/rain_check.py")
    assert contract.get_contract_version() == "raincheck-v2"
    assert contract.get_cover_count() == 0
    assert contract.get_available_reserve() == 0
    assert contract.get_cover(1) == {"found": False}

    direct_vm.warp("2026-10-04T00:00:00Z")
    direct_vm.sender = contract.get_owner()
    direct_vm.value = 50_000_000_000_000_000
    contract.fund_reserve()

    direct_vm.sender = direct_alice
    direct_vm.value = 2_000_000_000_000_000
    cover_id = contract.buy_cover(410082, 289784, "2026-10-05", 30)
    assert cover_id == 1
    assert contract.get_available_reserve() == 42_000_000_000_000_000
    direct_vm.value = 2_000_000_000_000_000
    second_id = contract.buy_cover(410082, 289784, "2026-10-06", 30)
    direct_vm.value = 2_000_000_000_000_000
    conflict_id = contract.buy_cover(410082, 289784, "2026-10-07", 30)
    direct_vm.value = 2_000_000_000_000_000
    retry_id = contract.buy_cover(410082, 289784, "2026-10-08", 30)

    direct_vm.mock_web(
        r"archive-api\.open-meteo\.com.*start_date=2026-10-05",
        {"status": 200, "body": json.dumps({"daily": {"precipitation_sum": [34.6]}})},
    )
    direct_vm.mock_web(
        r"power\.larc\.nasa\.gov.*start=20261005",
        {"status": 200, "body": json.dumps({"properties": {"parameter": {"PRECTOTCORR": {"20261005": 32.1}}}})},
    )
    direct_vm.warp("2026-10-06T00:00:00Z")
    result = contract.resolve_claim(cover_id)
    assert direct_vm.run_validator() is True
    differing_evidence = json.dumps(
        {"available": True, "open_meteo_mm_x10": 0, "nasa_power_mm_x10": 0},
        sort_keys=True,
    )
    assert direct_vm.run_validator(leader_result=differing_evidence) is False
    assert direct_vm._web_mocks_hit == {0, 1}, direct_vm._traces
    assert result == "APPROVED"
    assert contract.get_cover(cover_id)["status"] == "APPROVED"

    direct_vm.mock_web(
        r"archive-api\.open-meteo\.com.*start_date=2026-10-06",
        {"status": 200, "body": json.dumps({"daily": {"precipitation_sum": [12.0]}})},
    )
    direct_vm.mock_web(
        r"power\.larc\.nasa\.gov.*start=20261006",
        {"status": 200, "body": json.dumps({"properties": {"parameter": {"PRECTOTCORR": {"20261006": 18.5}}}})},
    )
    direct_vm.mock_web(
        r"archive-api\.open-meteo\.com.*start_date=2026-10-07",
        {"status": 200, "body": json.dumps({"daily": {"precipitation_sum": [34.0]}})},
    )
    direct_vm.mock_web(
        r"power\.larc\.nasa\.gov.*start=20261007",
        {"status": 200, "body": json.dumps({"properties": {"parameter": {"PRECTOTCORR": {"20261007": 18.0}}}})},
    )
    direct_vm.warp("2026-10-07T00:00:00Z")
    assert contract.resolve_claim(second_id) == "NO_TRIGGER"
    assert direct_vm.run_validator() is True
    assert contract.get_cover(second_id)["status"] == "NO_TRIGGER"
    direct_vm.warp("2026-10-08T00:00:00Z")
    assert contract.resolve_claim(conflict_id) == "SOURCE_REVIEW"
    assert direct_vm.run_validator() is True
    assert contract.get_cover(conflict_id)["status"] == "SOURCE_REVIEW"

    contract.refund_source_conflict(conflict_id)
    assert contract.get_cover(conflict_id)["status"] == "REFUNDED"
    contract.claim_payout(cover_id)
    assert contract.get_cover(cover_id)["status"] == "PAID"
    assert direct_vm._web_mocks_hit == {0, 1, 2, 3, 4, 5}

    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r"archive-api\.open-meteo\.com.*start_date=2026-10-08",
        {"status": 200, "body": json.dumps({"daily": {"precipitation_sum": [None]}})},
    )
    direct_vm.mock_web(
        r"power\.larc\.nasa\.gov.*start=20261008",
        {"status": 200, "body": json.dumps({"properties": {"parameter": {"PRECTOTCORR": {"20261008": 30.0}}}})},
    )
    direct_vm.warp("2026-10-09T00:00:00Z")
    assert contract.resolve_claim(retry_id) == "DATA_UNAVAILABLE"
    assert direct_vm.run_validator() is True
    assert direct_vm._web_mocks_hit == {0}

    direct_vm.clear_mocks()
    direct_vm.mock_web(
        r"archive-api\.open-meteo\.com.*start_date=2026-10-08",
        {"status": 200, "body": json.dumps({"daily": {"precipitation_sum": [10.0]}})},
    )
    direct_vm.mock_web(
        r"power\.larc\.nasa\.gov.*start=20261008",
        {"status": 200, "body": json.dumps({"properties": {"parameter": {"PRECTOTCORR": {"20261008": 12.0}}}})},
    )
    assert contract.resolve_claim(retry_id) == "NO_TRIGGER"
    assert direct_vm.run_validator() is True
    assert contract.get_cover(retry_id)["status"] == "NO_TRIGGER"
    assert direct_vm._web_mocks_hit == {0, 1}

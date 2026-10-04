# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
import json
from dataclasses import dataclass
from datetime import date, datetime
from genlayer import *


PREMIUM_WEI = u256(2_000_000_000_000_000)  # 0.002 GEN
PAYOUT_WEI = u256(10_000_000_000_000_000)  # 0.010 GEN
MIN_RESERVE_WEI = u256(50_000_000_000_000_000)  # 0.050 GEN
MIN_FUND_WEI = u256(1_000_000_000_000_000)  # 0.001 GEN
MAX_COVER_DAYS = 90


@allow_storage
@dataclass
class RainCover:
    cover_id: u256
    owner: Address
    latitude_e4: i256
    longitude_e4: i256
    event_date: str
    threshold_mm: u256
    premium_wei: u256
    payout_wei: u256
    status: str
    open_meteo_mm_x10: i256
    nasa_power_mm_x10: i256


@gl.evm.contract_interface
class _Recipient:
    class View:
        pass

    class Write:
        pass


class RainCheck(gl.Contract):
    owner: Address
    covers: DynArray[RainCover]
    total_reserve: u256
    locked_payouts: u256
    total_paid: u256

    def __init__(self):
        self.owner = gl.message.sender_address
        self.covers = []
        self.total_reserve = u256(0)
        self.locked_payouts = u256(0)
        self.total_paid = u256(0)

    def _today_utc(self) -> date:
        value = gl.message_raw["datetime"].replace("Z", "+00:00")
        return datetime.fromisoformat(value).date()

    def _decimal_coordinate(self, value_e4: int) -> str:
        sign = "-" if value_e4 < 0 else ""
        absolute = abs(value_e4)
        return f"{sign}{absolute // 10000}.{absolute % 10000:04d}"

    def _source_urls(self, cover: RainCover) -> tuple[str, str]:
        latitude = self._decimal_coordinate(cover.latitude_e4)
        longitude = self._decimal_coordinate(cover.longitude_e4)
        day = cover.event_date.replace("-", "")
        open_meteo = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={latitude}&longitude={longitude}&start_date={cover.event_date}"
            f"&end_date={cover.event_date}&daily=precipitation_sum&timezone=UTC"
        )
        nasa_power = (
            "https://power.larc.nasa.gov/api/temporal/daily/point"
            f"?parameters=PRECTOTCORR&community=AG&longitude={longitude}"
            f"&latitude={latitude}&start={day}&end={day}&format=JSON"
        )
        return open_meteo, nasa_power

    def _only_owner(self) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError("Only the pool owner can manage reserve funds.")

    @gl.public.write.payable
    def fund_reserve(self) -> None:
        self._only_owner()
        amount = gl.message.value
        if amount < MIN_FUND_WEI:
            raise gl.vm.UserError("Add at least 0.001 GEN of Studionet test liquidity.")
        self.total_reserve += amount

    @gl.public.write
    def withdraw_reserve(self, amount: u256) -> None:
        self._only_owner()
        if amount == 0:
            raise gl.vm.UserError("Withdrawal amount must be greater than zero.")
        available = self.total_reserve - self.locked_payouts
        if amount > available:
            raise gl.vm.UserError("Withdrawal exceeds free reserve; cover payouts stay locked.")
        self.total_reserve -= amount
        _Recipient(self.owner).emit_transfer(value=amount)

    @gl.public.write.payable
    def buy_cover(
        self,
        latitude_e4: i256,
        longitude_e4: i256,
        event_date: str,
        threshold_mm: u256,
    ) -> u256:
        if gl.message.value != PREMIUM_WEI:
            raise gl.vm.UserError("The testnet premium is exactly 0.002 GEN.")
        if latitude_e4 < -900000 or latitude_e4 > 900000:
            raise gl.vm.UserError("Latitude must be between -90 and 90 degrees.")
        if longitude_e4 < -1800000 or longitude_e4 > 1800000:
            raise gl.vm.UserError("Longitude must be between -180 and 180 degrees.")
        if threshold_mm < 5 or threshold_mm > 100:
            raise gl.vm.UserError("Rain threshold must be between 5 and 100 mm.")
        try:
            event_day = datetime.strptime(event_date, "%Y-%m-%d").date()
        except Exception:
            raise gl.vm.UserError("Event date must use YYYY-MM-DD format.")
        days_ahead = (event_day - self._today_utc()).days
        if days_ahead < 1 or days_ahead > MAX_COVER_DAYS:
            raise gl.vm.UserError("Choose a day from tomorrow through the next 90 days (UTC).")
        available = self.total_reserve + gl.message.value - self.locked_payouts
        if available < PAYOUT_WEI:
            raise gl.vm.UserError("The payout reserve is not funded yet.")

        cover_id = u256(len(self.covers) + 1)
        cover = RainCover(
            cover_id=cover_id,
            owner=gl.message.sender_address,
            latitude_e4=latitude_e4,
            longitude_e4=longitude_e4,
            event_date=event_date,
            threshold_mm=threshold_mm,
            premium_wei=PREMIUM_WEI,
            payout_wei=PAYOUT_WEI,
            status="ACTIVE",
            open_meteo_mm_x10=-1,
            nasa_power_mm_x10=-1,
        )
        self.covers.append(cover)
        self.total_reserve += gl.message.value
        self.locked_payouts += PAYOUT_WEI
        return cover_id

    @gl.public.write
    def resolve_claim(self, cover_id: u256) -> str:
        if cover_id < 1 or cover_id > len(self.covers):
            raise gl.vm.UserError("Cover not found.")
        cover = self.covers[int(cover_id) - 1]
        if cover.status not in ("ACTIVE", "SOURCE_REVIEW", "DATA_UNAVAILABLE"):
            raise gl.vm.UserError("This cover already has a final rainfall decision.")
        if datetime.strptime(cover.event_date, "%Y-%m-%d").date() >= self._today_utc():
            raise gl.vm.UserError("Wait until the covered UTC day has ended before resolving.")

        open_meteo_url, nasa_power_url = self._source_urls(cover)

        def fetch_compact_evidence() -> str:
            try:
                open_response = gl.nondet.web.get(open_meteo_url)
                open_data = json.loads(open_response.body.decode("utf-8"))
                open_values = open_data["daily"]["precipitation_sum"]
                if not open_values or open_values[0] is None:
                    return json.dumps({"available": False}, sort_keys=True)
                open_mm_x10 = int(round(float(open_values[0]) * 10))

                nasa_response = gl.nondet.web.get(nasa_power_url)
                nasa_data = json.loads(nasa_response.body.decode("utf-8"))
                day_key = cover.event_date.replace("-", "")
                nasa_value = nasa_data["properties"]["parameter"]["PRECTOTCORR"].get(day_key)
                if nasa_value is None or float(nasa_value) < 0:
                    return json.dumps({"available": False}, sort_keys=True)
                nasa_mm_x10 = int(round(float(nasa_value) * 10))
                return json.dumps(
                    {"available": True, "open_meteo_mm_x10": open_mm_x10, "nasa_power_mm_x10": nasa_mm_x10},
                    sort_keys=True,
                )
            except Exception:
                return json.dumps({"available": False}, sort_keys=True)

        agreed_json = gl.eq_principle.strict_eq(fetch_compact_evidence)
        evidence = json.loads(agreed_json)
        if not evidence.get("available"):
            cover.status = "DATA_UNAVAILABLE"
            return cover.status

        primary = int(evidence["open_meteo_mm_x10"])
        corroborating = int(evidence["nasa_power_mm_x10"])
        cover.open_meteo_mm_x10 = primary
        cover.nasa_power_mm_x10 = corroborating
        primary_triggered = primary >= int(cover.threshold_mm) * 10
        corroborating_triggered = corroborating >= int(cover.threshold_mm) * 10
        if primary_triggered != corroborating_triggered:
            cover.status = "SOURCE_REVIEW"
        elif primary_triggered:
            cover.status = "APPROVED"
        else:
            cover.status = "NO_TRIGGER"
            self.locked_payouts -= cover.payout_wei
        return cover.status

    @gl.public.write
    def claim_payout(self, cover_id: u256) -> None:
        if cover_id < 1 or cover_id > len(self.covers):
            raise gl.vm.UserError("Cover not found.")
        cover = self.covers[int(cover_id) - 1]
        if cover.status != "APPROVED":
            raise gl.vm.UserError("Only an approved cover can claim a payout.")
        if self.total_reserve < cover.payout_wei:
            raise gl.vm.UserError("The payout reserve is temporarily unavailable.")

        cover.status = "PAID"
        self.total_reserve -= cover.payout_wei
        self.locked_payouts -= cover.payout_wei
        self.total_paid += cover.payout_wei
        _Recipient(cover.owner).emit_transfer(value=cover.payout_wei)

    @gl.public.write
    def refund_source_conflict(self, cover_id: u256) -> None:
        if cover_id < 1 or cover_id > len(self.covers):
            raise gl.vm.UserError("Cover not found.")
        cover = self.covers[int(cover_id) - 1]
        if cover.status != "SOURCE_REVIEW":
            raise gl.vm.UserError("A premium refund is available only when sources conflict.")
        if self.total_reserve < cover.premium_wei:
            raise gl.vm.UserError("The premium reserve is temporarily unavailable.")

        cover.status = "REFUNDED"
        self.total_reserve -= cover.premium_wei
        self.locked_payouts -= cover.payout_wei
        _Recipient(cover.owner).emit_transfer(value=cover.premium_wei)

    @gl.public.view
    def get_contract_version(self) -> str:
        return "raincheck-v2"

    @gl.public.view
    def get_owner(self) -> Address:
        return self.owner

    @gl.public.view
    def get_reserve_state(self) -> dict:
        return {
            "total_reserve": self.total_reserve,
            "locked_payouts": self.locked_payouts,
            "available_reserve": self.total_reserve - self.locked_payouts,
            "total_paid": self.total_paid,
        }

    @gl.public.view
    def get_cover_count(self) -> u256:
        return u256(len(self.covers))

    @gl.public.view
    def get_available_reserve(self) -> u256:
        return self.total_reserve - self.locked_payouts

    @gl.public.view
    def get_cover(self, cover_id: u256) -> dict:
        if cover_id < 1 or cover_id > len(self.covers):
            return {"found": False}
        cover = self.covers[int(cover_id) - 1]
        return {
            "found": True,
            "cover_id": cover.cover_id,
            "owner": cover.owner.as_hex,
            "latitude_e4": cover.latitude_e4,
            "longitude_e4": cover.longitude_e4,
            "event_date": cover.event_date,
            "threshold_mm": cover.threshold_mm,
            "premium_wei": cover.premium_wei,
            "payout_wei": cover.payout_wei,
            "status": cover.status,
            "open_meteo_mm_x10": cover.open_meteo_mm_x10,
            "nasa_power_mm_x10": cover.nasa_power_mm_x10,
        }

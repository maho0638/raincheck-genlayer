"""Run Direct Mode tests against the legacy py-genlayer contract pin.

The current gltest prerelease targets the v0.3 SDK module layout while this
Studionet-ready contract pin uses genlayer.py.*. This local runner bridges the
test adapter APIs; the contract itself is loaded from the GenLayer SDK bundle.
"""

from __future__ import annotations

import importlib
import os
import sys
import tempfile
from pathlib import Path

import gltest.direct.loader as direct_loader
import gltest.direct.sdk_compat as sdk_compat
import gltest.direct.sdk_loader as sdk_loader
import gltest.direct.vm as direct_vm
import gltest.direct.wasi_mock as wasi_mock


def main() -> int:
    cache = Path(os.environ.get("RAIN_CHECK_GENVM_CACHE", Path(tempfile.gettempdir()) / "raincheck-genlayer-direct"))
    sdk_loader.CACHE_DIR = cache
    sdk_loader.BUNDLE_CACHE_DIR = cache / "bundles-v2"
    sdk_loader.TREE_CACHE_DIR = cache / "trees-v2"
    contract_path = Path("contracts/rain_check.py").resolve()
    version = sdk_loader.resolve_version()
    sdk_loader.setup_sdk_paths(contract_path, version)

    calldata = importlib.import_module("genlayer.py.calldata")
    types = importlib.import_module("genlayer.py.types")
    storage = importlib.import_module("genlayer.py.storage")
    storage_generate = importlib.import_module("genlayer.py.storage._internal.generate")

    sdk_compat.import_calldata = lambda: calldata
    sdk_compat.import_types = lambda: types
    sdk_compat.import_address = lambda: types.Address
    sdk_compat.import_address_u256 = lambda: (types.Address, types.u256)
    sdk_compat.import_lazy = lambda: types.Lazy
    direct_loader.import_calldata = sdk_compat.import_calldata
    direct_loader.import_address = sdk_compat.import_address
    direct_loader.import_lazy = sdk_compat.import_lazy
    direct_vm.import_address_u256 = sdk_compat.import_address_u256
    wasi_mock.import_calldata = sdk_compat.import_calldata

    original_refresh = direct_vm.VMContext._refresh_gl_message

    def refresh_legacy_message(vm):
        original_refresh(vm)
        gl = sys.modules.get("genlayer.gl")
        if gl is None:
            return
        sender = vm.sender if isinstance(vm.sender, types.Address) else types.Address(vm.sender)
        origin = vm.origin if isinstance(vm.origin, types.Address) else types.Address(vm.origin)
        raw = gl.message_raw
        raw.update(
            sender_address=sender,
            origin_address=origin,
            value=types.u256(vm._value),
            chain_id=types.u256(vm._chain_id),
            datetime=vm._datetime,
        )
        gl.message = gl.MessageType(
            contract_address=raw["contract_address"],
            sender_address=sender,
            origin_address=origin,
            value=types.u256(vm._value),
            chain_id=types.u256(vm._chain_id),
        )

    direct_vm.VMContext._refresh_gl_message = refresh_legacy_message

    def allocate_contract(contract_cls, vm, *args, **kwargs):
        storage.Root.MANAGER = vm._storage
        descriptor = storage_generate._storage_build(contract_cls, {})
        instance = descriptor.get(vm._storage.get_store_slot(storage.ROOT_SLOT_ID), 0)
        original = getattr(descriptor, "cls", None)
        initializer = getattr(original, "__init__", None) if original else contract_cls.__init__
        if hasattr(initializer, storage_generate.ORIGINAL_INIT_ATTR):
            initializer = getattr(initializer, storage_generate.ORIGINAL_INIT_ATTR)
        initializer(instance, *args, **kwargs)
        return instance

    direct_loader._allocate_contract = allocate_contract

    original_load = direct_loader._load_module

    def load_contract(path):
        contracts = importlib.import_module("genlayer.gl.genvm_contracts")
        contracts.__known_contract__ = None
        return original_load(path)

    direct_loader._load_module = load_contract

    original_patch_nondeterminism = direct_loader._patch_run_nondet_for_direct_mode

    def patch_legacy_nondeterminism():
        original_patch_nondeterminism()
        gl_vm = importlib.import_module("genlayer.gl.vm")

        def run_nondet_unsafe(leader, validator, /, **kwargs):
            from gltest.direct.wasi_mock import get_vm

            vm = get_vm()
            vm._in_nondet = True
            try:
                result = leader()
            finally:
                vm._in_nondet = False
            vm._captured_validators.append((result, leader, validator))
            return result

        run_nondet_unsafe.lazy = lambda leader, validator, /, **kwargs: types.Lazy(
            lambda: run_nondet_unsafe(leader, validator, **kwargs)
        )
        gl_vm.run_nondet_unsafe = run_nondet_unsafe

    direct_loader._patch_run_nondet_for_direct_mode = patch_legacy_nondeterminism

    def run_legacy_validator(vm, *, leader_result=direct_vm._sentinel, leader_error=None, index=-1):
        if not vm._captured_validators:
            raise RuntimeError("No validator captured. Run a contract method with nondeterministic evidence first.")
        stored_result, _leader, validator = vm._captured_validators[index]
        gl_vm = importlib.import_module("genlayer.gl.vm")
        if leader_error is not None:
            wrapped = gl_vm.UserError(str(leader_error))
        elif leader_result is not direct_vm._sentinel:
            wrapped = gl_vm.Return(calldata=leader_result)
        else:
            wrapped = gl_vm.Return(calldata=stored_result)
        original_spawn_sandbox = gl_vm.spawn_sandbox
        gl_vm.spawn_sandbox = lambda fn, **kwargs: gl_vm.Return(calldata=fn())
        try:
            return validator(wrapped)
        finally:
            gl_vm.spawn_sandbox = original_spawn_sandbox

    direct_vm.VMContext.run_validator = run_legacy_validator

    import pytest

    return int(pytest.main(["tests/test_direct_vm.py", "-q"]))


if __name__ == "__main__":
    raise SystemExit(main())

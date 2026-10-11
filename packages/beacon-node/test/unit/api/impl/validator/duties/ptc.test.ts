import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {pubkeyCache} from "@chainsafe/lodestar-z/pubkeys";
import {createBeaconConfig} from "@lodestar/config";
import {getConfig} from "@lodestar/config/test-utils";
import {ForkName, MAX_EFFECTIVE_BALANCE, SLOTS_PER_EPOCH} from "@lodestar/params";
import {BeaconStateGloas, BeaconStateView, createCachedBeaconState} from "@lodestar/state-transition";
import {getValidatorApi} from "../../../../../../src/api/impl/validator/index.js";
import {defaultApiOptions} from "../../../../../../src/api/options.js";
import {FAR_FUTURE_EPOCH} from "../../../../../../src/constants/index.js";
import {SyncState} from "../../../../../../src/sync/interface.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";
import {generateState} from "../../../../../utils/state.js";
import {generateProtoBlock} from "../../../../../utils/typeGenerator.js";
import {generateValidators} from "../../../../../utils/validator.js";

describe("getPtcDuties", () => {
  const config = getConfig(ForkName.gloas);
  const currentEpoch = 2;
  const decisionRoot = `0x${"cd".repeat(32)}`;
  let modules: ApiTestModules;
  let api: ReturnType<typeof getValidatorApi>;

  beforeEach(() => {
    const state = generateState(
      {
        slot: currentEpoch * SLOTS_PER_EPOCH,
        validators: generateValidators(4, {
          effectiveBalance: MAX_EFFECTIVE_BALANCE,
          activationEpoch: 0,
          exitEpoch: FAR_FUTURE_EPOCH,
        }),
      },
      config,
      true
    ) as BeaconStateGloas;
    const view = new BeaconStateView(
      createCachedBeaconState(state, {config: createBeaconConfig(config, state.genesisValidatorsRoot), pubkeyCache})
    );
    const ptcs = Array.from({length: SLOTS_PER_EPOCH}, () => new Uint32Array());
    ptcs[0] = Uint32Array.from([0]);
    ptcs[3] = Uint32Array.from([2]);
    vi.spyOn(view, "getEpochPTCs").mockReturnValue(ptcs);
    vi.spyOn(view, "getShufflingDecisionRoot").mockReturnValue(decisionRoot);

    modules = getApiTestModules({config});
    api = getValidatorApi(defaultApiOptions, modules);
    vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue(currentEpoch * SLOTS_PER_EPOCH);
    vi.spyOn(modules.chain.clock, "currentEpoch", "get").mockReturnValue(currentEpoch);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.Synced);
    modules.forkChoice.getHead.mockReturnValue(generateProtoBlock({slot: currentEpoch * SLOTS_PER_EPOCH}));
    modules.chain.getHeadStateAtCurrentEpoch.mockResolvedValue(view);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the assigned slot for each requested validator", async () => {
    const {data, meta} = await api.getPtcDuties({epoch: currentEpoch, indices: [0, 1, 2]});
    const startSlot = currentEpoch * SLOTS_PER_EPOCH;

    expect(data.map((duty) => [duty.validatorIndex, duty.slot])).toEqual([
      [0, startSlot],
      [2, startSlot + 3],
    ]);
    expect(meta.dependentRoot).toBe(decisionRoot);
    expect(meta.executionOptimistic).toBe(false);
  });

  it("rejects an empty index list, a pre-Gloas epoch, and an epoch more than one ahead", async () => {
    await expect(api.getPtcDuties({epoch: currentEpoch, indices: []})).rejects.toMatchObject({statusCode: 400});
    await expect(api.getPtcDuties({epoch: currentEpoch + 2, indices: [0]})).rejects.toMatchObject({statusCode: 400});

    const preGloas = getValidatorApi(defaultApiOptions, getApiTestModules());
    await expect(preGloas.getPtcDuties({epoch: 0, indices: [0]})).rejects.toMatchObject({statusCode: 400});
  });

  it("rejects the request while the node is syncing", async () => {
    vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue((currentEpoch + 3) * SLOTS_PER_EPOCH);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.SyncingHead);

    await expect(api.getPtcDuties({epoch: currentEpoch, indices: [0]})).rejects.toMatchObject({statusCode: 503});
  });
});

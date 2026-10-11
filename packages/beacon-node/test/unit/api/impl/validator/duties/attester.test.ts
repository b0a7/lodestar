import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {config} from "@lodestar/config/default";
import {ExecutionStatus} from "@lodestar/fork-choice";
import {FAR_FUTURE_EPOCH, SLOTS_PER_EPOCH} from "@lodestar/params";
import {BeaconStateView, EpochShuffling} from "@lodestar/state-transition";
import {getValidatorApi} from "../../../../../../src/api/impl/validator/index.js";
import {defaultApiOptions} from "../../../../../../src/api/options.js";
import {SyncState} from "../../../../../../src/sync/interface.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";
import {createCachedBeaconStateTest} from "../../../../../utils/cachedBeaconState.js";
import {generateState} from "../../../../../utils/state.js";
import {generateProtoBlock} from "../../../../../utils/typeGenerator.js";
import {generateValidators} from "../../../../../utils/validator.js";

describe("getAttesterDuties", () => {
  const currentEpoch = 2;
  const decisionRoot = `0x${"11".repeat(32)}`;
  let modules: ApiTestModules;
  let api: ReturnType<typeof getValidatorApi>;
  let view: BeaconStateView;

  beforeEach(() => {
    const state = generateState({
      slot: currentEpoch * SLOTS_PER_EPOCH,
      validators: generateValidators(4, {activationEpoch: 0, exitEpoch: FAR_FUTURE_EPOCH}),
    });
    view = new BeaconStateView(createCachedBeaconStateTest(state, config));
    vi.spyOn(view, "getShufflingDecisionRoot").mockReturnValue(decisionRoot);

    modules = getApiTestModules();
    api = getValidatorApi(defaultApiOptions, modules);
    vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue(currentEpoch * SLOTS_PER_EPOCH);
    vi.spyOn(modules.chain.clock, "currentEpoch", "get").mockReturnValue(currentEpoch);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.Synced);
    modules.forkChoice.getHead.mockReturnValue(
      generateProtoBlock({slot: currentEpoch * SLOTS_PER_EPOCH, executionStatus: ExecutionStatus.Valid})
    );
    modules.chain.getHeadStateAtCurrentEpoch.mockResolvedValue(view);
    vi.spyOn(modules.chain.shufflingCache, "get").mockResolvedValue(shuffling(currentEpoch));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns duties only for indices that have a committee", async () => {
    const {data, meta} = await api.getAttesterDuties({epoch: currentEpoch, indices: [0, 1, 3]});
    const slot = currentEpoch * SLOTS_PER_EPOCH + 1;

    expect(
      data.map((duty) => [duty.validatorIndex, duty.slot, duty.committeeIndex, duty.validatorCommitteeIndex])
    ).toEqual([
      [0, slot, 0, 0],
      [1, slot, 1, 0],
    ]);
    expect(data[0].committeeLength).toBe(2);
    expect(data[0].committeesAtSlot).toBe(2);
    expect(meta.dependentRoot).toBe(decisionRoot);
    expect(meta.executionOptimistic).toBe(false);
  });

  it("rejects an empty index list and an epoch more than one ahead", async () => {
    await expect(api.getAttesterDuties({epoch: currentEpoch, indices: []})).rejects.toMatchObject({statusCode: 400});
    await expect(api.getAttesterDuties({epoch: currentEpoch + 2, indices: [0]})).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("returns 500 when the shuffling cache misses", async () => {
    vi.mocked(modules.chain.shufflingCache.get).mockResolvedValue(null);

    await expect(api.getAttesterDuties({epoch: currentEpoch, indices: [0]})).rejects.toMatchObject({statusCode: 500});
  });

  it("rejects the request while the node is syncing", async () => {
    vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue((currentEpoch + 3) * SLOTS_PER_EPOCH);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.SyncingHead);

    await expect(api.getAttesterDuties({epoch: currentEpoch, indices: [0]})).rejects.toMatchObject({statusCode: 503});
  });
});

function shuffling(epoch: number): EpochShuffling {
  const committees: number[][][] = Array.from({length: SLOTS_PER_EPOCH}, () => []);
  committees[1] = [[0, 2], [1]];
  return {epoch, committees} as EpochShuffling;
}

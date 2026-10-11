import {beforeEach, describe, expect, it, vi} from "vitest";
import {SLOTS_PER_EPOCH} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {getValidatorApi} from "../../../../../src/api/impl/validator/index.js";
import {defaultApiOptions} from "../../../../../src/api/options.js";
import {AttestationError, AttestationErrorCode, GossipAction} from "../../../../../src/chain/errors/index.js";
import {InsertOutcome} from "../../../../../src/chain/opPools/types.js";
import {SyncState} from "../../../../../src/sync/interface.js";
import {ApiTestModules, getApiTestModules} from "../../../../utils/api.js";

vi.mock("../../../../../src/network/processor/gossipHandlers.js", async (importActual) => {
  const mod = await importActual<typeof import("../../../../../src/network/processor/gossipHandlers.js")>();
  return {...mod, validateGossipFnRetryUnknownRoot: vi.fn()};
});

const {validateGossipFnRetryUnknownRoot} = await import("../../../../../src/network/processor/gossipHandlers.js");

describe("api/validator - publishAggregateAndProofsV2", () => {
  let modules: ApiTestModules;
  let api: ReturnType<typeof getValidatorApi>;

  beforeEach(() => {
    modules = getApiTestModules();
    api = getValidatorApi(defaultApiOptions, modules);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.Synced);
    vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue(SLOTS_PER_EPOCH);
    modules.network.publishBeaconAggregateAndProof = vi.fn().mockResolvedValue(1);
    modules.chain.aggregatedAttestationPool.add = vi.fn().mockReturnValue(InsertOutcome.NewData);
    vi.mocked(validateGossipFnRetryUnknownRoot).mockResolvedValue({
      indexedAttestation: {attestingIndices: [1, 2]},
      committeeValidatorIndices: [1, 2],
      attDataRootHex: "0x01",
    });
  });

  it("adds a validated aggregate and publishes it", async () => {
    const signedAggregateAndProof = ssz.phase0.SignedAggregateAndProof.defaultValue();

    await api.publishAggregateAndProofsV2({signedAggregateAndProofs: [signedAggregateAndProof]});

    expect(modules.chain.aggregatedAttestationPool.add).toHaveBeenCalledOnce();
    expect(modules.network.publishBeaconAggregateAndProof).toHaveBeenCalledWith(signedAggregateAndProof);
  });

  it("ignores an aggregate the node has already seen", async () => {
    vi.mocked(validateGossipFnRetryUnknownRoot).mockRejectedValue(
      new AttestationError(GossipAction.IGNORE, {
        code: AttestationErrorCode.AGGREGATOR_ALREADY_KNOWN,
        targetEpoch: 1,
        aggregatorIndex: 3,
      })
    );

    await api.publishAggregateAndProofsV2({
      signedAggregateAndProofs: [ssz.phase0.SignedAggregateAndProof.defaultValue()],
    });

    expect(modules.chain.persistInvalidSszValue).not.toHaveBeenCalled();
    expect(modules.network.publishBeaconAggregateAndProof).not.toHaveBeenCalled();
  });

  it("returns the failing index and persists a gossip reject", async () => {
    const good = ssz.phase0.SignedAggregateAndProof.defaultValue();
    const bad = ssz.phase0.SignedAggregateAndProof.defaultValue();
    bad.message.aggregate.data.slot = 9;
    vi.mocked(validateGossipFnRetryUnknownRoot).mockImplementation(async () => {
      throw new AttestationError(GossipAction.REJECT, {code: AttestationErrorCode.INVALID_AGGREGATOR});
    });
    vi.mocked(validateGossipFnRetryUnknownRoot).mockResolvedValueOnce({
      indexedAttestation: {attestingIndices: [1]},
      committeeValidatorIndices: [1],
      attDataRootHex: "0x01",
    });

    await expect(api.publishAggregateAndProofsV2({signedAggregateAndProofs: [good, bad]})).rejects.toMatchObject({
      statusCode: 400,
      failures: [{index: 1, message: expect.stringContaining("INVALID_AGGREGATOR")}],
    });

    expect(modules.chain.aggregatedAttestationPool.add).toHaveBeenCalledOnce();
    expect(modules.chain.persistInvalidSszValue).toHaveBeenCalledOnce();
  });

  it("rejects the request while the node is syncing", async () => {
    vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue(SLOTS_PER_EPOCH * 4);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.SyncingHead);
    modules.forkChoice.getHead.mockReturnValue({slot: 0} as never);

    await expect(
      api.publishAggregateAndProofsV2({
        signedAggregateAndProofs: [ssz.phase0.SignedAggregateAndProof.defaultValue()],
      })
    ).rejects.toMatchObject({statusCode: 503});
  });
});

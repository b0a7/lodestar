import {beforeEach, describe, expect, it, vi} from "vitest";
import {ExecutionStatus} from "@lodestar/fork-choice";
import {DataAvailabilityStatus} from "@lodestar/state-transition";
import {ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {getValidatorApi} from "../../../../../src/api/impl/validator/index.js";
import {defaultApiOptions} from "../../../../../src/api/options.js";
import {BlockInputSource} from "../../../../../src/chain/blocks/blockInput/types.js";
import {SyncState} from "../../../../../src/sync/interface.js";
import {ApiTestModules, getApiTestModules} from "../../../../utils/api.js";
import {generateProtoBlock} from "../../../../utils/typeGenerator.js";

describe("api/validator - produceSyncCommitteeContribution", () => {
  const slot = 4;
  const subcommitteeIndex = 2;
  const beaconBlockRoot = Buffer.alloc(32, 0x21);
  const contribution = ssz.altair.SyncCommitteeContribution.defaultValue();
  let modules: ApiTestModules;
  let api: ReturnType<typeof getValidatorApi>;

  beforeEach(() => {
    modules = getApiTestModules();
    api = getValidatorApi(defaultApiOptions, modules);
    vi.spyOn(modules.sync, "state", "get").mockReturnValue(SyncState.Synced);
    modules.forkChoice.hasBlock.mockReturnValue(true);
    modules.forkChoice.getBlockDefaultStatus.mockReturnValue(
      generateProtoBlock({
        executionStatus: ExecutionStatus.Valid,
        dataAvailabilityStatus: DataAvailabilityStatus.Available,
      })
    );
    modules.network.searchUnknownBlock = vi.fn();
    modules.chain.waitForBlock = vi.fn().mockResolvedValue(true);
    modules.chain.syncCommitteeMessagePool = {
      getContribution: vi.fn().mockReturnValue(contribution),
    } as unknown as ApiTestModules["chain"]["syncCommitteeMessagePool"];
  });

  it("returns the pooled contribution for a known block", async () => {
    const res = await api.produceSyncCommitteeContribution({slot, subcommitteeIndex, beaconBlockRoot});

    expect(res.data).toBe(contribution);
    expect(modules.network.searchUnknownBlock).not.toHaveBeenCalled();
    expect(modules.chain.syncCommitteeMessagePool.getContribution).toHaveBeenCalledWith(
      subcommitteeIndex,
      slot,
      beaconBlockRoot
    );
  });

  it("searches for an unknown block before producing the contribution", async () => {
    modules.forkChoice.hasBlock.mockReturnValue(false);

    await api.produceSyncCommitteeContribution({slot, subcommitteeIndex, beaconBlockRoot});

    expect(modules.network.searchUnknownBlock).toHaveBeenCalledWith(
      {slot, root: toRootHex(beaconBlockRoot)},
      BlockInputSource.api
    );
    expect(modules.chain.waitForBlock).toHaveBeenCalledWith(slot, toRootHex(beaconBlockRoot));
  });

  it("returns 404 when the pool has no contribution", async () => {
    modules.chain.syncCommitteeMessagePool.getContribution.mockReturnValue(null);

    await expect(
      api.produceSyncCommitteeContribution({slot, subcommitteeIndex, beaconBlockRoot})
    ).rejects.toMatchObject({statusCode: 404});
  });

  it("rejects an optimistic block and data that is out of range", async () => {
    modules.forkChoice.getBlockDefaultStatus.mockReturnValue(
      generateProtoBlock({executionStatus: ExecutionStatus.Syncing})
    );
    await expect(
      api.produceSyncCommitteeContribution({slot, subcommitteeIndex, beaconBlockRoot})
    ).rejects.toMatchObject({statusCode: 503});

    modules.forkChoice.getBlockDefaultStatus.mockReturnValue(
      generateProtoBlock({
        executionStatus: ExecutionStatus.Valid,
        dataAvailabilityStatus: DataAvailabilityStatus.OutOfRange,
      })
    );
    await expect(
      api.produceSyncCommitteeContribution({slot, subcommitteeIndex, beaconBlockRoot})
    ).rejects.toMatchObject({statusCode: 503});
  });
});

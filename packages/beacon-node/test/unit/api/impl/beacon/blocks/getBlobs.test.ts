import {beforeEach, describe, expect, it, vi} from "vitest";
import {getConfig} from "@lodestar/config/test-utils";
import {ForkName, NUMBER_OF_COLUMNS} from "@lodestar/params";
import {SignedBeaconBlock, deneb, ssz} from "@lodestar/types";
import {toHex} from "@lodestar/utils";
import {getBeaconBlockApi} from "../../../../../../src/api/impl/beacon/blocks/index.js";
import {kzgCommitmentToVersionedHash} from "../../../../../../src/util/blobs.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";

const {reconstructBlobsMock, inclusionProofMock} = vi.hoisted(() => ({
  reconstructBlobsMock: vi.fn(),
  inclusionProofMock: vi.fn(() => [new Uint8Array(32)]),
}));

vi.mock("../../../../../../src/util/blobs.js", async (importActual) => {
  const mod = await importActual<typeof import("../../../../../../src/util/blobs.js")>();
  return {
    ...mod,
    reconstructBlobs: reconstructBlobsMock,
    computePreFuluKzgCommitmentsInclusionProof: inclusionProofMock,
  };
});

vi.mock("../../../../../../src/util/kzg.js", () => ({
  kzg: {
    asyncComputeBlobKzgProof: vi.fn(async () => new Uint8Array(48)),
  },
}));

describe("getBlobs and getBlobSidecars", () => {
  const halfCustody = NUMBER_OF_COLUMNS / 2;
  const commitmentA = Uint8Array.from({length: 48}, (_, i) => i + 1);
  const commitmentB = Uint8Array.from({length: 48}, (_, i) => i + 2);

  beforeEach(() => {
    reconstructBlobsMock.mockReset();
    reconstructBlobsMock.mockImplementation(async (_columns: unknown, indices: number[]) =>
      indices.map((index) => Uint8Array.from([index]))
    );
  });

  describe("before Deneb", () => {
    const {api} = setup(getApiTestModules(), ssz.phase0.SignedBeaconBlock.defaultValue());

    it("returns an empty blob list and empty sidecars", async () => {
      expect((await api.getBlobs({blockId: 0})).data).toEqual([]);
      expect((await api.getBlobSidecars({blockId: 0})).data).toEqual([]);
    });
  });

  describe("Deneb", () => {
    it("filters blobs by versioned hash in index order and sidecars by index", async () => {
      const block = ssz.deneb.SignedBeaconBlock.defaultValue();
      block.message.body.blobKzgCommitments = [commitmentA, commitmentB];
      const sidecars = [sidecar(1, Uint8Array.from([1])), sidecar(0, Uint8Array.from([0]))];
      const {api, modules} = setup(getApiTestModules({config: getConfig(ForkName.deneb)}), block, sidecars);
      const hashB = toHex(kzgCommitmentToVersionedHash(commitmentB));
      const hashA = toHex(kzgCommitmentToVersionedHash(commitmentA));

      const blobs = await api.getBlobs({blockId: block.message.slot, versionedHashes: [hashB, hashA]});
      const filtered = await api.getBlobSidecars({blockId: block.message.slot, indices: [1]});

      expect(blobs.data).toEqual([Uint8Array.from([0]), Uint8Array.from([1])]);
      expect(filtered.data).toEqual([sidecar(1, Uint8Array.from([1]))]);
      expect(modules.chain.getBlobSidecars).toHaveBeenCalled();
      expect(reconstructBlobsMock).not.toHaveBeenCalled();
    });

    it("returns 400 for an unknown versioned hash and 404 when sidecars are missing", async () => {
      const block = ssz.deneb.SignedBeaconBlock.defaultValue();
      block.message.body.blobKzgCommitments = [commitmentA];
      const sidecars = [sidecar(0, Uint8Array.from([0]))];
      const stored = setup(getApiTestModules({config: getConfig(ForkName.deneb)}), block, sidecars);
      const missing = setup(getApiTestModules({config: getConfig(ForkName.deneb)}), block, null);

      await expect(
        stored.api.getBlobs({blockId: block.message.slot, versionedHashes: [`0x${"ff".repeat(32)}`]})
      ).rejects.toMatchObject({statusCode: 400});
      await expect(missing.api.getBlobSidecars({blockId: block.message.slot})).rejects.toMatchObject({statusCode: 404});
      expect(stored.modules.chain.getDataColumnSidecars).not.toHaveBeenCalled();
    });

    it("rejects duplicate versioned hashes and duplicate sidecar indices", async () => {
      const block = ssz.deneb.SignedBeaconBlock.defaultValue();
      const {api} = setup(getApiTestModules({config: getConfig(ForkName.deneb)}), block, []);
      const hash = `0x${"aa".repeat(32)}`;

      await expect(api.getBlobs({blockId: 0, versionedHashes: [hash, hash]})).rejects.toMatchObject({statusCode: 400});
      await expect(api.getBlobSidecars({blockId: 0, indices: [1, 1]})).rejects.toMatchObject({statusCode: 400});
    });
  });

  describe("Fulu", () => {
    it("reconstructs requested blobs from data columns", async () => {
      const block = ssz.fulu.SignedBeaconBlock.defaultValue();
      block.message.body.blobKzgCommitments = [commitmentA, commitmentB];
      const columns = [{index: 0}];
      const {api} = setup(getApiTestModules({config: getConfig(ForkName.fulu)}), block, [], columns);
      const hashB = toHex(kzgCommitmentToVersionedHash(commitmentB));

      const blobs = await api.getBlobs({blockId: block.message.slot, versionedHashes: [hashB]});
      const sidecars = await api.getBlobSidecars({blockId: block.message.slot, indices: [1]});

      expect(reconstructBlobsMock).toHaveBeenCalledWith(columns, [1]);
      expect(blobs.data).toEqual([Uint8Array.from([1])]);
      expect(sidecars.data.map((sidecar) => sidecar.index)).toEqual([1]);
      expect(sidecars.data[0].blob).toEqual(Uint8Array.from([1]));
    });

    it("returns 503 below half custody, 400 for a bad index, and 404 when columns are missing", async () => {
      const block = ssz.fulu.SignedBeaconBlock.defaultValue();
      block.message.body.blobKzgCommitments = [commitmentA];
      const lowCustody = setup(getApiTestModules({config: getConfig(ForkName.fulu)}), block, [], [{index: 0}], 1);
      const missing = setup(getApiTestModules({config: getConfig(ForkName.fulu)}), block, [], []);
      const badIndex = setup(getApiTestModules({config: getConfig(ForkName.fulu)}), block, [], [{index: 0}]);

      await expect(lowCustody.api.getBlobs({blockId: block.message.slot})).rejects.toMatchObject({statusCode: 503});
      await expect(lowCustody.api.getBlobSidecars({blockId: block.message.slot})).rejects.toMatchObject({
        statusCode: 503,
      });
      await expect(missing.api.getBlobs({blockId: block.message.slot})).rejects.toMatchObject({statusCode: 404});
      await expect(badIndex.api.getBlobSidecars({blockId: block.message.slot, indices: [3]})).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("returns an empty list when the block has no blobs", async () => {
      const block = ssz.fulu.SignedBeaconBlock.defaultValue();
      const {api} = setup(getApiTestModules({config: getConfig(ForkName.fulu)}), block, [], []);

      expect((await api.getBlobs({blockId: block.message.slot})).data).toEqual([]);
      expect((await api.getBlobSidecars({blockId: block.message.slot})).data).toEqual([]);
      expect(reconstructBlobsMock).not.toHaveBeenCalled();
    });
  });

  function setup(
    modules: ApiTestModules,
    block: SignedBeaconBlock,
    blobSidecars: deneb.BlobSidecars | null = [],
    dataColumnSidecars: {index: number}[] = [],
    targetCustodyGroupCount = halfCustody
  ): {api: ReturnType<typeof getBeaconBlockApi>; modules: ApiTestModules} {
    const api = getBeaconBlockApi(modules);
    modules.chain.getCanonicalBlockAtSlot.mockResolvedValue({
      block,
      executionOptimistic: false,
      finalized: true,
    });
    modules.chain.getBlobSidecars = vi.fn().mockResolvedValue(blobSidecars);
    modules.chain.getDataColumnSidecars = vi.fn().mockResolvedValue(dataColumnSidecars);
    modules.chain.custodyConfig = {targetCustodyGroupCount} as ApiTestModules["chain"]["custodyConfig"];
    return {api, modules};
  }

  function sidecar(index: number, blob: Uint8Array): deneb.BlobSidecar {
    return {...ssz.deneb.BlobSidecar.defaultValue(), index, blob};
  }
});

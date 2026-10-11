import {beforeEach, describe, expect, it, vi} from "vitest";
import {getConfig} from "@lodestar/config/test-utils";
import {ForkName} from "@lodestar/params";
import {ssz} from "@lodestar/types";
import {getBeaconBlockApi} from "../../../../../../src/api/impl/beacon/blocks/index.js";
import {
  EnvelopeReconstructionError,
  EnvelopeReconstructionErrorCode,
} from "../../../../../../src/chain/errors/envelopeReconstructionError.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";
import {generateSignedExecutionPayloadEnvelope} from "../../../../../utils/typeGenerator.js";

describe("getSignedExecutionPayloadEnvelope", () => {
  const envelope = generateSignedExecutionPayloadEnvelope(3);

  describe("Gloas", () => {
    let modules: ApiTestModules;
    let api: ReturnType<typeof getBeaconBlockApi>;

    beforeEach(() => {
      modules = getApiTestModules({config: getConfig(ForkName.gloas)});
      api = getBeaconBlockApi(modules);
      modules.chain.getExecutionPayloadEnvelope = vi.fn();
      const block = ssz.gloas.SignedBeaconBlock.defaultValue();
      block.message.slot = 3;
      modules.chain.getCanonicalBlockAtSlot.mockResolvedValue({
        block,
        executionOptimistic: false,
        finalized: true,
      });
    });

    it("returns the stored envelope", async () => {
      modules.chain.getExecutionPayloadEnvelope.mockResolvedValue(envelope);

      const res = await api.getSignedExecutionPayloadEnvelope({blockId: 3});

      expect(res.data).toBe(envelope);
      expect(res.meta).toMatchObject({executionOptimistic: false, finalized: true, version: ForkName.gloas});
    });

    it("returns 404 when the envelope is not stored", async () => {
      modules.chain.getExecutionPayloadEnvelope.mockResolvedValue(null);

      await expect(api.getSignedExecutionPayloadEnvelope({blockId: 3})).rejects.toMatchObject({statusCode: 404});
    });

    it("maps reconstruction failures to 503 or 500", async () => {
      modules.chain.getExecutionPayloadEnvelope.mockRejectedValueOnce(
        new EnvelopeReconstructionError({code: EnvelopeReconstructionErrorCode.ENGINE_UNAVAILABLE})
      );
      await expect(api.getSignedExecutionPayloadEnvelope({blockId: 3})).rejects.toMatchObject({statusCode: 503});

      modules.chain.getExecutionPayloadEnvelope.mockRejectedValueOnce(
        new EnvelopeReconstructionError({code: EnvelopeReconstructionErrorCode.BODY_UNAVAILABLE, slot: 3})
      );
      await expect(api.getSignedExecutionPayloadEnvelope({blockId: 3})).rejects.toMatchObject({statusCode: 503});

      modules.chain.getExecutionPayloadEnvelope.mockRejectedValueOnce(
        new EnvelopeReconstructionError({
          code: EnvelopeReconstructionErrorCode.BODY_ROOT_MISMATCH,
          slot: 3,
          field: "transactions",
        })
      );
      await expect(api.getSignedExecutionPayloadEnvelope({blockId: 3})).rejects.toMatchObject({statusCode: 500});
    });
  });

  it("rejects a pre-Gloas block", async () => {
    const modules = getApiTestModules();
    const api = getBeaconBlockApi(modules);
    modules.chain.getCanonicalBlockAtSlot.mockResolvedValue({
      block: ssz.phase0.SignedBeaconBlock.defaultValue(),
      executionOptimistic: false,
      finalized: true,
    });

    await expect(api.getSignedExecutionPayloadEnvelope({blockId: 0})).rejects.toMatchObject({statusCode: 400});
  });
});

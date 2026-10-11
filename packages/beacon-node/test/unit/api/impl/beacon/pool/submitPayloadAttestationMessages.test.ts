import {beforeEach, describe, expect, it, vi} from "vitest";
import {ssz} from "@lodestar/types";
import {toRootHex} from "@lodestar/utils";
import {getBeaconPoolApi} from "../../../../../../src/api/impl/beacon/pool/index.js";
import {
  GossipAction,
  PayloadAttestationError,
  PayloadAttestationErrorCode,
} from "../../../../../../src/chain/errors/index.js";
import {InsertOutcome} from "../../../../../../src/chain/opPools/types.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";

vi.mock("../../../../../../src/network/processor/gossipHandlers.js", async (importActual) => {
  const mod = await importActual<typeof import("../../../../../../src/network/processor/gossipHandlers.js")>();
  return {...mod, validateGossipFnRetryUnknownRoot: vi.fn()};
});

const {validateGossipFnRetryUnknownRoot} = await import("../../../../../../src/network/processor/gossipHandlers.js");

describe("api - beacon - submitPayloadAttestationMessages", () => {
  const validation = {attDataRootHex: "0xabc", validatorCommitteeIndices: [4, 5]};
  let modules: ApiTestModules;
  let api: ReturnType<typeof getBeaconPoolApi>;

  beforeEach(() => {
    modules = getApiTestModules();
    api = getBeaconPoolApi(modules);
    modules.chain.payloadAttestationPool.add.mockReturnValue(InsertOutcome.NewData);
    modules.network.publishPayloadAttestationMessage = vi.fn().mockResolvedValue(1);
    vi.spyOn(modules.chain.emitter, "emit");
    vi.mocked(validateGossipFnRetryUnknownRoot).mockResolvedValue(validation);
  });

  it("pools the message, notifies fork choice, and publishes it", async () => {
    const message = ssz.gloas.PayloadAttestationMessage.defaultValue();
    message.data.slot = 6;
    message.data.payloadPresent = true;
    message.data.blobDataAvailable = false;
    message.validatorIndex = 4;

    await api.submitPayloadAttestationMessages({payloadAttestationMessages: [message]});

    expect(modules.chain.payloadAttestationPool.add).toHaveBeenCalledWith(
      message,
      validation.attDataRootHex,
      validation.validatorCommitteeIndices
    );
    expect(modules.forkChoice.notifyPtcMessages).toHaveBeenCalledWith(
      toRootHex(message.data.beaconBlockRoot),
      6,
      validation.validatorCommitteeIndices,
      true,
      false
    );
    expect(modules.chain.emitter.emit).toHaveBeenCalledOnce();
    expect(modules.network.publishPayloadAttestationMessage).toHaveBeenCalledWith(message);
  });

  it("ignores a message the node has already seen", async () => {
    vi.mocked(validateGossipFnRetryUnknownRoot).mockRejectedValue(
      new PayloadAttestationError(GossipAction.IGNORE, {
        code: PayloadAttestationErrorCode.PAYLOAD_ATTESTATION_ALREADY_KNOWN,
        validatorIndex: 4,
        slot: 6,
        blockRoot: `0x${"00".repeat(32)}`,
      })
    );

    await api.submitPayloadAttestationMessages({
      payloadAttestationMessages: [ssz.gloas.PayloadAttestationMessage.defaultValue()],
    });

    expect(modules.chain.payloadAttestationPool.add).not.toHaveBeenCalled();
    expect(modules.chain.persistInvalidSszValue).not.toHaveBeenCalled();
  });

  it("returns the failing index and persists a gossip reject", async () => {
    vi.mocked(validateGossipFnRetryUnknownRoot)
      .mockResolvedValueOnce(validation)
      .mockRejectedValueOnce(
        new PayloadAttestationError(GossipAction.REJECT, {
          code: PayloadAttestationErrorCode.INVALID_SIGNATURE,
        })
      );

    await expect(
      api.submitPayloadAttestationMessages({
        payloadAttestationMessages: [
          ssz.gloas.PayloadAttestationMessage.defaultValue(),
          ssz.gloas.PayloadAttestationMessage.defaultValue(),
        ],
      })
    ).rejects.toMatchObject({
      statusCode: 400,
      failures: [{index: 1, message: expect.stringContaining("INVALID_SIGNATURE")}],
    });

    expect(modules.chain.persistInvalidSszValue).toHaveBeenCalledOnce();
    expect(modules.network.publishPayloadAttestationMessage).toHaveBeenCalledOnce();
  });
});

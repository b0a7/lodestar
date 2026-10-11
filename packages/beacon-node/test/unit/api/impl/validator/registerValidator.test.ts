import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {getConfig} from "@lodestar/config/test-utils";
import {FAR_FUTURE_EPOCH, ForkName} from "@lodestar/params";
import {phase0, ssz} from "@lodestar/types";
import {getValidatorApi} from "../../../../../src/api/impl/validator/index.js";
import {defaultApiOptions} from "../../../../../src/api/options.js";
import {ApiTestModules, getApiTestModules} from "../../../../utils/api.js";
import {generateValidator} from "../../../../utils/validator.js";

describe("api/validator - registerValidator and prepareBeaconProposer", () => {
  const proposers = [{validatorIndex: 1, feeRecipient: `0x${"ab".repeat(20)}`}];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("before Gloas", () => {
    let modules: ApiTestModules;
    let api: ReturnType<typeof getValidatorApi>;
    const validators = [
      generateValidator({activationEpoch: 0, activationEligibilityEpoch: 0, exitEpoch: FAR_FUTURE_EPOCH}),
      generateValidator({activationEpoch: 0, activationEligibilityEpoch: 0, exitEpoch: 6}),
      generateValidator({activationEpoch: 0, activationEligibilityEpoch: 0, exitEpoch: 6, slashed: true}),
      generateValidator({
        activationEpoch: FAR_FUTURE_EPOCH,
        activationEligibilityEpoch: FAR_FUTURE_EPOCH,
        exitEpoch: FAR_FUTURE_EPOCH,
      }),
      generateValidator({
        activationEpoch: FAR_FUTURE_EPOCH,
        activationEligibilityEpoch: 0,
        exitEpoch: FAR_FUTURE_EPOCH,
      }),
      generateValidator({
        activationEpoch: 0,
        activationEligibilityEpoch: 0,
        exitEpoch: 1,
        withdrawableEpoch: FAR_FUTURE_EPOCH,
      }),
    ];

    beforeEach(() => {
      modules = getApiTestModules();
      api = getValidatorApi(defaultApiOptions, modules);
      vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue(0);
      vi.spyOn(modules.chain.clock, "currentEpoch", "get").mockReturnValue(5);
      modules.chain.executionBuilder.registerValidator = vi.fn().mockResolvedValue(undefined);
      modules.chain.updateBeaconProposerData = vi.fn().mockResolvedValue(undefined);
      modules.chain.getHeadState.mockReturnValue({
        validatorCount: validators.length,
        getValidator: (index: number) => validators[index],
      } as unknown as ReturnType<ApiTestModules["chain"]["getHeadState"]>);
      vi.spyOn(modules.chain.pubkeyCache, "getIndex").mockImplementation((pubkey) => pubkey[0]);
    });

    it("forwards only active and pending registrations", async () => {
      const registrations = validators.map((validator, index) => {
        const registration = ssz.bellatrix.SignedValidatorRegistrationV1.defaultValue();
        registration.message.pubkey = Uint8Array.from(validator.pubkey);
        registration.message.pubkey[0] = index;
        return registration;
      });

      await api.registerValidator({registrations});

      const forwarded = modules.chain.executionBuilder.registerValidator.mock
        .calls[0][1] as phase0.SignedValidatorRegistrationV1[];
      expect(modules.chain.executionBuilder.registerValidator).toHaveBeenCalledOnce();
      expect(forwarded.map((registration) => registration.message.pubkey[0])).toEqual([0, 1, 2, 3, 4]);
    });

    it("throws when no execution builder is configured", async () => {
      modules.chain.executionBuilder = undefined as unknown as ApiTestModules["chain"]["executionBuilder"];

      await expect(api.registerValidator({registrations: []})).rejects.toThrow("External builder not configured");
    });

    it("stores proposer preparations for the current epoch", async () => {
      await api.prepareBeaconProposer({proposers});

      expect(modules.chain.updateBeaconProposerData).toHaveBeenCalledExactlyOnceWith(5, proposers);
    });
  });

  describe("from Gloas", () => {
    let modules: ApiTestModules;
    let api: ReturnType<typeof getValidatorApi>;

    beforeEach(() => {
      modules = getApiTestModules({config: getConfig(ForkName.gloas)});
      api = getValidatorApi(defaultApiOptions, modules);
      vi.spyOn(modules.chain.clock, "currentSlot", "get").mockReturnValue(0);
      modules.chain.executionBuilder.registerValidator = vi.fn().mockResolvedValue(undefined);
      modules.chain.updateBeaconProposerData = vi.fn().mockResolvedValue(undefined);
    });

    it("rejects validator registrations", async () => {
      await expect(api.registerValidator({registrations: []})).rejects.toMatchObject({statusCode: 410});
      expect(modules.chain.executionBuilder.registerValidator).not.toHaveBeenCalled();
    });

    it("rejects proposer preparations", async () => {
      await expect(api.prepareBeaconProposer({proposers})).rejects.toMatchObject({statusCode: 410});
      expect(modules.chain.updateBeaconProposerData).not.toHaveBeenCalled();
    });
  });
});

import {beforeEach, describe, expect, it, vi} from "vitest";
import {routes} from "@lodestar/api";
import {VoluntaryExitValidity} from "@lodestar/state-transition";
import {ssz} from "@lodestar/types";
import {getBeaconPoolApi} from "../../../../../../src/api/impl/beacon/pool/index.js";
import {ApiTestModules, getApiTestModules} from "../../../../../utils/api.js";

vi.mock("../../../../../../src/chain/validation/voluntaryExit.js", () => ({
  validateApiVoluntaryExit: vi.fn(),
}));

const {validateApiVoluntaryExit} = await import("../../../../../../src/chain/validation/voluntaryExit.js");

describe("api - beacon - submitPoolVoluntaryExit", () => {
  let modules: ApiTestModules;
  let api: ReturnType<typeof getBeaconPoolApi>;
  const insert = vi.fn();

  beforeEach(() => {
    modules = getApiTestModules();
    api = getBeaconPoolApi(modules);
    insert.mockReset();
    insert.mockReturnValue(true);
    modules.chain.deferredVoluntaryExitPool = {
      insert,
      has: vi.fn(),
    } as unknown as ApiTestModules["chain"]["deferredVoluntaryExitPool"];
    modules.network.publishVoluntaryExit = vi.fn().mockResolvedValue(1);
    modules.chain.opPool.insertVoluntaryExit = vi.fn();
    vi.spyOn(modules.chain.emitter, "emit");
    vi.spyOn(modules.chain.clock, "currentEpoch", "get").mockReturnValue(7);
    vi.mocked(validateApiVoluntaryExit).mockResolvedValue({status: "published"});
  });

  it("publishes an exit that is valid now", async () => {
    const signedVoluntaryExit = ssz.phase0.SignedVoluntaryExit.defaultValue();

    await api.submitPoolVoluntaryExit({signedVoluntaryExit});

    expect(modules.chain.opPool.insertVoluntaryExit).toHaveBeenCalledWith(signedVoluntaryExit);
    expect(modules.chain.emitter.emit).toHaveBeenCalledWith(routes.events.EventType.voluntaryExit, signedVoluntaryExit);
    expect(modules.network.publishVoluntaryExit).toHaveBeenCalledWith(signedVoluntaryExit);
    expect(insert).not.toHaveBeenCalled();
  });

  it("defers an exit whose transient checks have not passed", async () => {
    vi.mocked(validateApiVoluntaryExit).mockResolvedValue({
      status: "deferred",
      validity: VoluntaryExitValidity.earlyEpoch,
    });
    const signedVoluntaryExit = ssz.phase0.SignedVoluntaryExit.defaultValue();

    await api.submitPoolVoluntaryExit({signedVoluntaryExit});

    expect(insert).toHaveBeenCalledWith(signedVoluntaryExit, VoluntaryExitValidity.earlyEpoch, 7);
    expect(modules.network.publishVoluntaryExit).not.toHaveBeenCalled();
    expect(modules.chain.opPool.insertVoluntaryExit).not.toHaveBeenCalled();
  });

  it("returns 400 when the deferred pool rejects the exit", async () => {
    vi.mocked(validateApiVoluntaryExit).mockResolvedValue({
      status: "deferred",
      validity: VoluntaryExitValidity.shortTimeActive,
    });
    insert.mockReturnValue(false);

    await expect(
      api.submitPoolVoluntaryExit({signedVoluntaryExit: ssz.phase0.SignedVoluntaryExit.defaultValue()})
    ).rejects.toMatchObject({statusCode: 400});
    expect(modules.network.publishVoluntaryExit).not.toHaveBeenCalled();
  });
});

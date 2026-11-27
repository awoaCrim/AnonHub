import { afterEach, expect, it, vi } from "vitest";

import { api, ApiError } from "../web/src/lib/api";
import { clearCaches } from "../web/src/lib/cache";

afterEach(() => clearCaches());
const path = "/yesimbot/api/v1/plugins/config?path=yesimbot%3Amain";
const json = (revision: string) => new Response(JSON.stringify({ revision }));

it("authoritative API reads bypass a warm cache and preserve normal cache behavior", async () => {
  let revision = "old";
  const fetcher = vi.fn(async () => json(revision));
  expect(await api(path, undefined, {}, fetcher)).toEqual({ revision: "old" });
  revision = "latest";
  expect(await api(path, undefined, {}, fetcher)).toEqual({ revision: "old" });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(await api(path, undefined, { fresh: true }, fetcher)).toEqual({ revision: "latest" });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]).toEqual([path, expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" })]);
});

it("authoritative API reads never join an older in-flight cached request", async () => {
  let finishOld!: (value: Response) => void;
  const fetcher = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockResolvedValueOnce(json("latest"));
  const old = api(path, undefined, {}, fetcher);
  expect(await api(path, undefined, { fresh: true }, fetcher)).toEqual({ revision: "latest" });
  finishOld(json("old"));
  expect(await old).toEqual({ revision: "old" });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("fresh read failures propagate instead of returning a cached successful snapshot", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(json("cached"))
    .mockResolvedValueOnce(new Response('{"message":"not_found"}', { status: 404 }));
  await api(path, undefined, {}, fetcher);
  await expect(api(path, undefined, { fresh: true }, fetcher)).rejects.toEqual(new ApiError(404, "not_found"));
});

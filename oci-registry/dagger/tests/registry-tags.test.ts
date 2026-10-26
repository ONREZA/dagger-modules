import { expect, test } from "bun:test";
import type { Secret } from "../sdk/index.js";
import { OciRegistry } from "../src/index.js";

const repository = "cr.selcloud.ru/team/image";
const secret = {} as Secret;
const tokenError = () => Object.assign(new Error("process exited with code 1"), {
  stderr: "GET https://cr.selcloud.ru/auth?scope=repository%3Ateam%2Fimage%3Apull&service=cr.selcloud.ru: unexpected status code 401 Unauthorized",
});

function tagReader(retryCount: number, read: (attempt: number) => string) {
  const registry = new OciRegistry(retryCount, 1, 1);
  const attempts: number[] = [];
  Object.assign(registry, {
    crane: async (_auth: Secret, attempt: number) => {
      attempts.push(attempt);
      return {
        withExec: () => ({ stdout: async () => read(attempt) }),
      };
    },
  });
  return { registry, attempts };
}

test("tag listing retries a rejected token with a distinct execution identity", async () => {
  const { registry, attempts } = tagReader(3, (attempt) => {
    if (attempt === 1) throw tokenError();
    return "retained\nprotected\n";
  });
  expect(await registry.listOptionalTags(repository, secret)).toEqual(["retained", "protected"]);
  expect(attempts).toEqual([1, 2]);
});

test("zero retry budget preserves a scoped authentication failure", async () => {
  const error = tokenError();
  const { registry, attempts } = tagReader(0, () => { throw error; });
  await expect(registry.listOptionalTags(repository, secret)).rejects.toBe(error);
  expect(attempts).toEqual([1]);
});

test("tag listing retries a transient missing inventory before optional fallback", async () => {
  const { registry, attempts } = tagReader(1, (attempt) => {
    if (attempt === 1) throw new Error("404 Not Found");
    return "retained\n";
  });
  expect(await registry.listOptionalTags(repository, secret)).toEqual(["retained"]);
  expect(attempts).toEqual([1, 2]);
});

test("persistent tag-list absence remains optional after its retry budget", async () => {
  const { registry, attempts } = tagReader(1, () => { throw new Error("404 Not Found"); });
  expect(await registry.listOptionalTags(repository, secret)).toEqual([]);
  expect(attempts).toEqual([1, 2]);
});

test("persistent authentication fails after one refresh despite remaining retry budget", async () => {
  const error = tokenError();
  const { registry, attempts } = tagReader(3, () => { throw error; });
  await expect(registry.listOptionalTags(repository, secret)).rejects.toBe(error);
  expect(attempts).toEqual([1, 2]);
});

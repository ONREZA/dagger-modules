import { describe, expect, test } from "bun:test";
import { parseDockerConfigCredentials } from "../src/index.js";

describe("dockerconfigjson credentials", () => {
  test("reads direct and base64 registry credentials", () => {
    expect(
      parseDockerConfigCredentials(
        JSON.stringify({
          auths: {
            "https://cr.example.test/v1/": {
              auth: btoa("token:secret"),
            },
          },
        }),
        "cr.example.test",
      ),
    ).toEqual({ username: "token", password: "secret" });

    expect(
      parseDockerConfigCredentials(
        JSON.stringify({
          auths: {
            "cr.example.test": {
              username: "robot",
              password: "password",
            },
          },
        }),
        "cr.example.test",
      ),
    ).toEqual({ username: "robot", password: "password" });

    expect(
      parseDockerConfigCredentials(
        JSON.stringify({
          auths: {
            "https://index.docker.io/v1/": {
              auth: btoa("docker-user:docker-token"),
            },
          },
        }),
        "docker.io",
      ),
    ).toEqual({ username: "docker-user", password: "docker-token" });
  });
});

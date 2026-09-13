import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { enforceAuthorization } from "../../src/dashboard/http.js";
import { ServiceError } from "../../src/dashboard/service.js";

describe("Dashboard Authorization", () => {
  const originalEnv = process.env.DASHBOARD_ADMIN_TOKEN;

  afterEach(() => {
    process.env.DASHBOARD_ADMIN_TOKEN = originalEnv;
  });

  it("allows access when DASHBOARD_ADMIN_TOKEN is not set", () => {
    delete process.env.DASHBOARD_ADMIN_TOKEN;
    const req = new Request("http://localhost/");
    expect(() => enforceAuthorization(req)).not.toThrow();
  });

  it("rejects access when token is set but authorization header is missing", () => {
    process.env.DASHBOARD_ADMIN_TOKEN = "secret-token";
    const req = new Request("http://localhost/");
    
    let error: any;
    try {
      enforceAuthorization(req);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(401);
  });

  it("rejects access when authorization header is invalid", () => {
    process.env.DASHBOARD_ADMIN_TOKEN = "secret-token";
    const req = new Request("http://localhost/", {
      headers: { authorization: "Bearer wrong-token" },
    });
    
    let error: any;
    try {
      enforceAuthorization(req);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ServiceError);
    expect(error.status).toBe(401);
  });

  it("allows access when authorization header matches the token", () => {
    process.env.DASHBOARD_ADMIN_TOKEN = "secret-token";
    const req = new Request("http://localhost/", {
      headers: { authorization: "Bearer secret-token" },
    });
    
    expect(() => enforceAuthorization(req)).not.toThrow();
  });
});

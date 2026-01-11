/**
 * Tests for the shared model manager module.
 *
 * This tests the core model management functionality that all backends share,
 * including caching, in-flight deduplication, and model selection.
 *
 * NOTE: Uses direct imports since the model manager is a factory that creates
 * fresh instances for each test case.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createModelManager } from "../lib/backends/modelManager.js";

test("createModelManager initializes with default model", async () => {
  const manager = createModelManager({
    defaultModel: "test-model-v1",
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => null
  });

  assert.equal(manager.getActiveModel(), "test-model-v1");
});

test("updateModelSelection updates active model", async () => {
  const manager = createModelManager({
    defaultModel: "default-model",
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => null
  });

  manager.updateModelSelection({ model: "new-model" });
  assert.equal(manager.getActiveModel(), "new-model");

  // Empty string clears selection
  manager.updateModelSelection({ model: "" });
  assert.equal(manager.getActiveModel(), null);

  // Null explicitly clears selection
  manager.updateModelSelection({ model: null });
  assert.equal(manager.getActiveModel(), null);
});

test("updateModelSelection trims whitespace from model names", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => null
  });

  manager.updateModelSelection({ model: "  spaced-model  " });
  assert.equal(manager.getActiveModel(), "spaced-model");
});

test("effort handling when supportsEffort is true", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: true,
    defaultEffort: "medium",
    effortOptions: ["low", "medium", "high"],
    fetchModels: async () => null
  });

  // Default effort
  assert.equal(manager.getActiveEffort(), "medium");

  // Update to valid effort
  manager.updateModelSelection({ effort: "HIGH" });
  assert.equal(manager.getActiveEffort(), "high", "effort should be normalized to lowercase");

  // Invalid effort keeps current value
  manager.updateModelSelection({ effort: "ultra" });
  assert.equal(manager.getActiveEffort(), "high", "invalid effort should be ignored");

  // Clear effort
  manager.updateModelSelection({ effort: "" });
  assert.equal(manager.getActiveEffort(), null);
});

test("effort cleared when non-string values are passed", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: true,
    defaultEffort: "medium",
    effortOptions: ["low", "medium", "high"],
    fetchModels: async () => null
  });

  // Set initial effort
  manager.updateModelSelection({ effort: "high" });
  assert.equal(manager.getActiveEffort(), "high");

  // Null clears effort
  manager.updateModelSelection({ effort: null });
  assert.equal(manager.getActiveEffort(), null);

  // Set effort again
  manager.updateModelSelection({ effort: "low" });
  assert.equal(manager.getActiveEffort(), "low");

  // Number clears effort
  manager.updateModelSelection({ effort: 123 as any });
  assert.equal(manager.getActiveEffort(), null);

  // Set effort again
  manager.updateModelSelection({ effort: "medium" });
  assert.equal(manager.getActiveEffort(), "medium");

  // Boolean clears effort
  manager.updateModelSelection({ effort: true as any });
  assert.equal(manager.getActiveEffort(), null);

  // Set effort again
  manager.updateModelSelection({ effort: "high" });
  assert.equal(manager.getActiveEffort(), "high");

  // Object clears effort
  manager.updateModelSelection({ effort: {} as any });
  assert.equal(manager.getActiveEffort(), null);
});

test("effort is ignored when supportsEffort is false", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => null
  });

  assert.equal(manager.getActiveEffort(), null);

  // Try to set effort
  manager.updateModelSelection({ effort: "high" });
  assert.equal(manager.getActiveEffort(), null, "effort should remain null");
});

test("getModelSettings includes fetched models", async () => {
  const manager = createModelManager({
    defaultModel: "default-model",
    supportsEffort: true,
    defaultEffort: "medium",
    effortOptions: ["low", "medium", "high"],
    fetchModels: async () => ["model-a", "model-b", "model-c"]
  });

  const settings = await manager.getModelSettings();

  assert.deepEqual(settings.availableModels, ["model-a", "model-b", "model-c"]);
  assert.equal(settings.defaultModel, "default-model");
  assert.equal(settings.defaultEffort, "medium");
  assert.deepEqual(settings.effortOptions, ["low", "medium", "high"]);
});

test("model fetching caches results", async () => {
  let fetchCount = 0;
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => {
      fetchCount += 1;
      return ["model-" + fetchCount];
    }
  });

  // First call
  const first = await manager.getModelSettings();
  assert.equal(fetchCount, 1);
  assert.deepEqual(first.availableModels, ["model-1"]);

  // Second call uses cache
  const second = await manager.getModelSettings();
  assert.equal(fetchCount, 1, "should not fetch again within cache TTL");
  assert.deepEqual(second.availableModels, ["model-1"]);
});

test("concurrent fetches are deduplicated", async () => {
  let fetchCount = 0;
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => {
      fetchCount += 1;
      await new Promise((r) => setTimeout(r, 10));
      return ["model-concurrent"];
    }
  });

  // Fire multiple concurrent requests
  const [first, second, third] = await Promise.all([
    manager.getModelSettings(),
    manager.getModelSettings(),
    manager.getModelSettings()
  ]);

  assert.equal(fetchCount, 1, "concurrent requests should share single fetch");
  assert.deepEqual(first.availableModels, second.availableModels);
  assert.deepEqual(second.availableModels, third.availableModels);
});

test("configModels are merged with API results", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => ["api-model-1", "api-model-2"],
    configModels: ["config-model-1", "api-model-1"] // One duplicate
  });

  const settings = await manager.getModelSettings();

  // Should have unique, sorted models
  assert.deepEqual(settings.availableModels, ["api-model-1", "api-model-2", "config-model-1"]);
});

test("fetch errors result in empty model list with config fallback", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => {
      throw new Error("Network error");
    },
    configModels: ["fallback-model"]
  });

  const settings = await manager.getModelSettings();

  // Should still have config models
  assert.deepEqual(settings.availableModels, ["fallback-model"]);
});

test("null fetch result with no config yields empty list", async () => {
  const manager = createModelManager({
    defaultModel: null,
    supportsEffort: false,
    defaultEffort: null,
    effortOptions: [],
    fetchModels: async () => null
  });

  const settings = await manager.getModelSettings();
  assert.deepEqual(settings.availableModels, []);
});

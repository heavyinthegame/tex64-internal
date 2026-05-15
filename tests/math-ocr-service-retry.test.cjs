const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const { MathOcrService } = require("../electron/services/math-ocr/service.cjs");

test("MathOcrService.ensureLoaded retries after a missing model config", async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tex64-math-ocr-retry-"));
  const modelDir = path.join(tmp, "Resources", "math-ocr");
  const originalLoad = Module._load;
  let sessionCreateCount = 0;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "onnxruntime-node") {
      return {
        Tensor: class FakeTensor {},
        InferenceSession: {
          create: async (modelPath) => {
            sessionCreateCount += 1;
            return {
              outputMetadata: modelPath.endsWith("decoder.onnx")
                ? [{ name: "logits", shape: [1, 1, 4] }]
                : [{ name: "last_hidden_state", shape: [1, 1, 4] }],
            };
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const service = new MathOcrService({
      appPath: tmp,
      userDataPath: tmp,
      isPackaged: false,
      resourcesPath: "",
    });
    service.ensureTesseractWorker = async () => null;

    await assert.rejects(
      () => service.ensureLoaded(),
      /Math OCR model is not installed/
    );

    await fsp.mkdir(modelDir, { recursive: true });
    await fsp.writeFile(
      path.join(modelDir, "config.json"),
      JSON.stringify({
        encoder: "encoder.onnx",
        decoder: "decoder.onnx",
        tokenizer: "tokenizer.json",
      }),
      "utf8"
    );
    await fsp.writeFile(
      path.join(modelDir, "tokenizer.json"),
      JSON.stringify({ model: { vocab: { "<s>": 1, "</s>": 2, "x": 3 } } }),
      "utf8"
    );

    await service.ensureLoaded();

    assert.ok(service.encoderSession, "encoder session should be initialized");
    assert.ok(service.decoderSession, "decoder session should be initialized");
    assert.equal(sessionCreateCount, 2);
  } finally {
    Module._load = originalLoad;
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

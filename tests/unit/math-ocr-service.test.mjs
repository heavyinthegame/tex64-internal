import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { MathOcrService } = require("../../electron/services/math-ocr.cjs");

const makeDataUrl = (seed) =>
  `data:image/png;base64,${Buffer.from(String(seed).repeat(80)).toString("base64")}`;

const createPayload = (primaryImage, fallbackImages = []) => {
  const tensor = new Float32Array(384 * 384 * 3);
  return {
    data: tensor.buffer,
    width: 384,
    height: 384,
    imageDataUrl: primaryImage,
    fallbackImageDataUrls: fallbackImages,
  };
};

const createMockService = ({ decodeOutputs = [], fallbackByImage = {} } = {}) => {
  const service = new MathOcrService({
    appPath: process.cwd(),
    userDataPath: process.cwd(),
  });

  let decodeIndex = 0;

  service.ensureLoaded = async () => {
    service.config = {
      decodeStrategy: "greedy",
      filterThres: 0.9,
      topP: 0.9,
      temperature: 1,
      bosToken: 1,
      eosToken: 2,
      decoderStartToken: 2,
      maxSeqLen: 32,
      channels: 3,
      encoderInput: "pixel_values",
      encoderOutput: "last_hidden_state",
      decoderInputTokens: "input_ids",
      decoderInputContext: "encoder_hidden_states",
      decoderOutput: "logits",
    };
  };

  service.runEncoder = async () => ({ mock: true });

  service.decodeWithContext = async () => {
    if (decodeIndex >= decodeOutputs.length) {
      return "";
    }
    const value = decodeOutputs[decodeIndex];
    decodeIndex += 1;
    if (value instanceof Error) {
      throw value;
    }
    return value;
  };

  service.recognizeFallback = async (imageDataUrl) => {
    if (imageDataUrl in fallbackByImage) {
      return fallbackByImage[imageDataUrl];
    }
    return { text: "", confidence: null };
  };

  return service;
};

test("MathOcrService selects best decode candidate", async () => {
  const primaryImage = makeDataUrl("primary");
  const service = createMockService({
    decodeOutputs: ["\\begin{array}", "\\frac{a}{b}", "\\frac{a}{b}"],
  });
  const result = await service.recognize(createPayload(primaryImage));
  assert.equal(result.latex, "\\frac{a}{b}");
});

test("MathOcrService selects best fallback candidate", async () => {
  const primaryImage = makeDataUrl("primary");
  const fallbackA = makeDataUrl("fallback-a");
  const fallbackB = makeDataUrl("fallback-b");
  const service = createMockService({
    decodeOutputs: ["\\begin{array}"],
    fallbackByImage: {
      [primaryImage]: { text: "x2+1", confidence: 61 },
      [fallbackA]: { text: "x2+1", confidence: 74 },
      [fallbackB]: { text: "x^2+1", confidence: 92 },
    },
  });
  const result = await service.recognize(createPayload(primaryImage, [fallbackA, fallbackB]));
  assert.equal(result.latex, "x^2+1");
});

test("MathOcrService preserves valid pix2tex output over fallback", async () => {
  const primaryImage = makeDataUrl("primary");
  const service = createMockService({
    decodeOutputs: ["\\frac{a}{b}"],
    fallbackByImage: {
      [primaryImage]: { text: "x^2+1", confidence: 99 },
    },
  });
  const result = await service.recognize(createPayload(primaryImage));
  assert.equal(result.latex, "\\frac{a}{b}");
});

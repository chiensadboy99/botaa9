const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

let currentData = {
  "phien_truoc": null,
  "ket_qua": "",
  "Dice": [],
  "phien_hien_tai": null,
  "du_doan": "",
  "do_tin_cay": "",
  "cau": "",
  "ngay": "",
  "Id": "@NguyenTung2029"
};

let currentSessionId = null;
let lastKnownResultSessionId = null;
let patternHistory = [];
let diceHistory = [];
let lastRawPredictions = [];

let predictionPerformance = {};

let strategyWeights = {
    "Cầu Bệt": 1.0,
    "Cầu 1-1": 1.0,
    "Cầu Lặp 2-1": 1.0,
    "Cầu Lặp 2-2": 1.0,
    "Cầu Lặp 3-1": 1.0,
    "Cầu Lặp 3-2": 1.0,
    "Cầu Lặp 3-3": 1.0,
    "Cầu Lặp 4-1": 1.0,
    "Cầu Lặp 4-2": 1.0,
    "Cầu Lặp 4-3": 1.0,
    "Cầu Lặp 4-4": 1.0,
    "Cầu Đối Xứng": 1.2,
    "Cầu Đảo Ngược": 1.1,
    "Cầu Ziczac Ngắn": 0.8,
    "Cầu Lặp Chuỗi Khác": 1.0,
    "Xu hướng Tài mạnh (Ngắn)": 1.0,
    "Xu hướng Xỉu mạnh (Ngắn)": 1.0,
    "Xu hướng Tài rất mạnh (Dài)": 1.2,
    "Xu hướng Xỉu rất mạnh (Dài)": 1.2,
    "Xu hướng tổng điểm": 0.9,
    "Bộ ba": 1.3,
    "Điểm 10": 0.8,
    "Điểm 11": 0.8,
    "Bẻ cầu bệt dài": 1.6,
    "Bẻ cầu 1-1 dài": 1.6,
    "Reset Cầu/Bẻ Sâu": 1.9
};

function generateCommonPatterns() {
    let patterns = [];

    for (let i = 3; i <= 20; i++) {
        patterns.push({
            name: `Cầu Bệt Tài (${i})`,
            pattern: "T".repeat(i),
            predict: "T",
            conf: 0.05 + (i * 0.005),
            minHistory: i,
            strategyGroup: "Cầu Bệt"
        });
        patterns.push({
            name: `Cầu Bệt Xỉu (${i})`,
            pattern: "X".repeat(i),
            predict: "X",
            conf: 0.05 + (i * 0.005),
            minHistory: i,
            strategyGroup: "Cầu Bệt"
        });
    }

    for (let i = 3; i <= 20; i++) {
        let patternTX = "";
        let patternXT = "";
        for (let j = 0; j < i; j++) {
            patternTX += (j % 2 === 0 ? "T" : "X");
            patternXT += (j % 2 === 0 ? "X" : "T");
        }
        patterns.push({
            name: `Cầu 1-1 (TX - ${i})`,
            pattern: patternTX,
            predict: (i % 2 === 0 ? "T" : "X"),
            conf: 0.05 + (i * 0.005),
            minHistory: i,
            strategyGroup: "Cầu 1-1"
        });
        patterns.push({
            name: `Cầu 1-1 (XT - ${i})`,
            pattern: patternXT,
            predict: (i % 2 === 0 ? "X" : "T"),
            conf: 0.05 + (i * 0.005),
            minHistory: i,
            strategyGroup: "Cầu 1-1"
        });
    }

    const baseRepeatedPatterns = [
        { base: "TTX", group: "Cầu Lặp 2-1" }, { base: "XXT", group: "Cầu Lặp 2-1" },
        { base: "TTXX", group: "Cầu Lặp 2-2" }, { base: "XXTT", group: "Cầu Lặp 2-2" },
        { base: "TTTX", group: "Cầu Lặp 3-1" }, { base: "XXXT", group: "Cầu Lặp 3-1" },
        { base: "TTTXX", group: "Cầu Lặp 3-2" }, { base: "XXXTT", group: "Cầu Lặp 3-2" },
        { base: "TTTXXX", group: "Cầu Lặp 3-3" }, { base: "XXXTTT", group: "Cầu Lặp 3-3" },
        { base: "TTTTX", group: "Cầu Lặp 4-1" }, { base: "XXXXT", group: "Cầu Lặp 4-1" },
        { base: "TTTTXX", group: "Cầu Lặp 4-2" }, { base: "XXXXTT", group: "Cầu Lặp 4-2" },
        { base: "TTTTXXX", group: "Cầu Lặp 4-3" }, { base: "XXXXTTT", group: "Cầu Lặp 4-3" },
        { base: "TTTTXXXX", group: "Cầu Lặp 4-4" }, { base: "XXXXTTTT", group: "Cầu Lặp 4-4" }
    ];

    baseRepeatedPatterns.forEach(patternInfo => {
        for (let numRepeats = 1; numRepeats <= 5; numRepeats++) {
            let currentPattern = patternInfo.base.repeat(numRepeats);
            let predictChar = patternInfo.base[0];

            patterns.push({
                name: `${patternInfo.group} (${patternInfo.base} x${numRepeats})`,
                pattern: currentPattern,
                predict: predictChar,
                conf: 0.08 + (numRepeats * 0.01),
                minHistory: currentPattern.length,
                strategyGroup: patternInfo.group
            });
        }
    });

    const symmetricAndInversePatterns = [
        { base: "TX", predict: "T", group: "Cầu Đối Xứng" },
        { base: "XT", predict: "X", group: "Cầu Đối Xứng" },
        { base: "TXXT", predict: "T", group: "Cầu Đối Xứng" },
        { base: "XTTX", predict: "X", group: "Cầu Đối Xứng" },
        { base: "TTXT", predict: "X", group: "Cầu Đảo Ngược" },
        { base: "XXTX", predict: "T", group: "Cầu Đảo Ngược" },
        { base: "TXTXT", predict: "X", group: "Cầu Đối Xứng" },
        { base: "XTXTX", predict: "T", group: "Cầu Đối Xứng" },
    ];

    symmetricAndInversePatterns.forEach(patternInfo => {
        for (let numRepeats = 1; numRepeats <= 3; numRepeats++) {
            let currentPattern = patternInfo.base.repeat(numRepeats);
            patterns.push({
                name: `${patternInfo.group} (${patternInfo.base} x${numRepeats})`,
                pattern: currentPattern,
                predict: patternInfo.predict,
                conf: 0.1 + (numRepeats * 0.015),
                minHistory: currentPattern.length,
                strategyGroup: patternInfo.group
            });
        }
        if (patternInfo.base.length === 2) {
            let patternABBA = patternInfo.base + patternInfo.base.split('').reverse().join('');
            patterns.push({
                name: `${patternInfo.group} (${patternABBA})`,
                pattern: patternABBA,
                predict: patternInfo.base[0],
                conf: 0.15,
                minHistory: patternABBA.length,
                strategyGroup: patternInfo.group
            });
            let patternABCCBA = patternInfo.base.repeat(2) + patternInfo.base.split('').reverse().join('').repeat(2);
            if (patternABCCBA.length <= 10) {
                patterns.push({
                    name: `${patternInfo.group} (${patternABCCBA})`,
                    pattern: patternABCCBA,
                    predict: patternInfo.base[0],
                    conf: 0.18,
                    minHistory: patternABCCBA.length,
                    strategyGroup: patternInfo.group
                });
            }
        }
    });

    const shortZiczacPatterns = [
        { pattern: "TTX", predict: "T" }, { pattern: "XXT", predict: "X" },
        { pattern: "TXT", predict: "X" }, { pattern: "XTX", predict: "T" },
        { pattern: "TXX", predict: "X" }, { pattern: "XTT", predict: "T" },
        { pattern: "TTXX", predict: "T" }, { pattern: "XXTT", predict: "X" },
        { pattern: "TXTX", predict: "T" }, { pattern: "XTXT", predict: "X" },
        { pattern: "XTTX", predict: "X" }, { pattern: "TXXT", predict: "T" }
    ];
    shortZiczacPatterns.forEach(p => {
        patterns.push({
            name: `Cầu Ziczac Ngắn (${p.pattern})`,
            pattern: p.pattern,
            predict: p.predict,
            conf: 0.05,
            minHistory: p.pattern.length,
            strategyGroup: "Cầu Ziczac Ngắn"
        });
    });
    
    const complexRepeats = ["TTX", "XXT", "TXT", "TXX", "XTT"];
    complexRepeats.forEach(base => {
        for (let i = 2; i <= 4; i++) {
            const currentPattern = base.repeat(i);
            if (currentPattern.length <= 15) {
                patterns.push({
                    name: `Cầu Lặp Chuỗi Khác (${base} x${i})`,
                    pattern: currentPattern,
                    predict: base[0],
                    conf: 0.07 + (i * 0.01),
                    minHistory: currentPattern.length,
                    strategyGroup: "Cầu Lặp Chuỗi Khác"
                });
            }
        }
    });

    return patterns;
}

const allPatternStrategies = generateCommonPatterns();
console.log(`[Khởi tạo] Tổng số mẫu cầu đã tạo: ${allPatternStrategies.length}`);

allPatternStrategies.forEach(pattern => {
    if (strategyWeights[pattern.strategyGroup] === undefined) {
        strategyWeights[pattern.strategyGroup] = 1.0;
        predictionPerformance[pattern.strategyGroup] = { correct: 0, total: 0 };
    }
});

function analyzeAndPredict(history, diceHist) {
  const analysis = {
    totalResults: history.length,
    taiCount: history.filter(r => r === 'T').length,
    xiuCount: history.filter(r => r === 'X').length,
    last50Pattern: history.slice(-50).join(''),
    last200Pattern: history.join(''),
    predictionDetails: [],
    rawPredictions: []
  };

  let finalPrediction = "?";
  let combinedConfidence = 0;

  const recentHistoryFull = history.join('');
  const recent50 = history.slice(-50).join('');
  const recent20 = history.slice(-20).join('');
  const recent10 = history.slice(-10).join('');

  const addPrediction = (strategyName, predict, confMultiplier, detail, strategyGroup = null) => {
    if (!predictionPerformance[strategyName]) {
        predictionPerformance[strategyName] = { correct: 0, total: 0 };
    }
    const effectiveStrategyName = strategyGroup || strategyName;
    if (strategyWeights[effectiveStrategyName] === undefined) {
        strategyWeights[effectiveStrategyName] = 1.0;
    }
    const weight = strategyWeights[effectiveStrategyName];
    const confidence = confMultiplier * weight;
    analysis.rawPredictions.push({ strategy: strategyName, predict, confidence, detail, strategyGroup: effectiveStrategyName });
  };

  for (const p of allPatternStrategies) {
    if (history.length >= p.minHistory) {
        let targetHistoryString;
        if (p.minHistory <= 10) targetHistoryString = recent10;
        else if (p.minHistory <= 20) targetHistoryString = recent20;
        else if (p.minHistory <= 50) targetHistoryString = recent50;
        else targetHistoryString = recentHistoryFull;

        if (targetHistoryString.endsWith(p.pattern)) {
            addPrediction(p.name, p.predict, p.conf, `Phát hiện: ${p.name}`, p.strategyGroup);
        }
    }
  }

  if (history.length >= 7) {
    if (recentHistoryFull.endsWith("TTTTTTT")) {
      addPrediction("Bẻ cầu bệt dài", "X", 0.35, "Cầu bệt Tài quá dài (>7), dự đoán bẻ cầu");
    } else if (recentHistoryFull.endsWith("XXXXXXX")) {
      addPrediction("Bẻ cầu bệt dài", "T", 0.35, "Cầu bệt Xỉu quá dài (>7), dự đoán bẻ cầu");
    }

    if (recentHistoryFull.endsWith("XTXTXTXT")) {
        addPrediction("Bẻ cầu 1-1 dài", "X", 0.3, "Cầu 1-1 quá dài (>8), dự đoán bẻ sang Xỉu");
    } else if (recentHistoryFull.endsWith("TXTXTXTX")) {
        addPrediction("Bẻ cầu 1-1 dài", "T", 0.3, "Cầu 1-1 quá dài (>8), dự đoán bẻ sang Tài");
    }
  }

  const taiIn20 = history.slice(-20).filter(r => r === 'T').length;
  const xiuIn20 = history.slice(-20).filter(r => r === 'X').length;

  if (taiIn20 > xiuIn20 + 5) {
    addPrediction("Xu hướng Tài mạnh (Ngắn)", "T", 0.25, `Xu hướng 20 phiên: Nghiêng về Tài (${taiIn20} Tài / ${xiuIn20} Xỉu)`);
  } else if (xiuIn20 > taiIn20 + 5) {
    addPrediction("Xu hướng Xỉu mạnh (Ngắn)", "X", 0.25, `Xu hướng 20 phiên: Nghiêng về Xỉu (${taiIn20} Tài / ${xiuIn20} Xỉu)`);
  } else {
    analysis.predictionDetails.push(`Xu hướng 20 phiên: Khá cân bằng (${taiIn20} Tài / ${xiuIn20} Xỉu)`);
  }
  
  const taiIn50 = history.slice(-50).filter(r => r === 'T').length;
  const xiuIn50 = history.slice(-50).filter(r => r === 'X').length;
  if (taiIn50 > xiuIn50 + 8) {
    addPrediction("Xu hướng Tài rất mạnh (Dài)", "T", 0.3, `Xu hướng 50 phiên: Rất nghiêng về Tài (${taiIn50} Tài / ${xiuIn50} Xỉu)`);
  } else if (xiuIn50 > taiIn50 + 8) {
    addPrediction("Xu hướng Xỉu rất mạnh (Dài)", "X", 0.3, `Xu hướng 50 phiên: Rất nghiêng về Xỉu (${taiIn50} Tài / ${xiuIn50} Xỉu)`);
  }

  if (diceHist.length > 0) {
    const lastResult = diceHist[diceHist.length - 1];
    const total = lastResult.d1 + lastResult.d2 + lastResult.d3;
    analysis.predictionDetails.push(`Kết quả xúc xắc gần nhất: ${lastResult.d1}-${lastResult.d2}-${lastResult.d3} (Tổng: ${total})`);

    const last10Totals = diceHist.slice(-10).map(d => d.total);
    const sumCounts = last10Totals.reduce((acc, val) => {
      acc[val] = (acc[val] || 0) + 1;
      return acc;
    }, {});

    let mostFrequentTotal = 0;
    let maxCount = 0;
    for (const sum in sumCounts) {
      if (sumCounts[sum] > maxCount) {
        maxCount = sumCounts[sum];
        mostFrequentTotal = parseInt(sum);
      }
    }

    if (maxCount >= 4) {
        const predict = mostFrequentTotal > 10 ? "T" : "X";
        addPrediction("Xu hướng tổng điểm", predict, 0.15, `Tổng điểm ${mostFrequentTotal} xuất hiện nhiều trong 10 phiên gần nhất`);
    }

    if (lastResult.d1 === lastResult.d2 && lastResult.d2 === lastResult.d3) {
        const predict = (lastResult.d1 <= 3) ? "T" : "X";
        addPrediction("Bộ ba", predict, 0.25, `Phát hiện bộ ba ${lastResult.d1}, dự đoán bẻ cầu`);
    }

    if (total === 10) {
        addPrediction("Điểm 10", "X", 0.08, "Tổng 10 (Xỉu) vừa ra, thường là điểm dao động hoặc bẻ cầu");
    } else if (total === 11) {
        addPrediction("Điểm 11", "T", 0.08, "Tổng 11 (Tài) vừa ra, thường là điểm dao động hoặc bẻ cầu");
    }
  }

  if (history.length > 20) {
      const last10 = history.slice(-10);
      const taiIn10 = last10.filter(r => r === 'T').length;
      const xiuIn10 = last10.filter(r => r === 'X').length;

      if (Math.abs(taiIn10 - xiuIn10) <= 2) {
          if (analysis.rawPredictions.length === 0 || analysis.rawPredictions[0].confidence < 0.2) {
              const lastResult = history[history.length - 1];
              const predict = (lastResult === 'T' ? 'X' : 'T');
              addPrediction("Reset Cầu/Bẻ Sâu", predict, 0.28, "Cầu đang loạn hoặc khó đoán, dự đoán reset.");
          }
      }
      if (recentHistoryFull.endsWith("TTTTTTTTT")) {
          addPrediction("Reset Cầu/Bẻ Sâu", "X", 0.4, "Cầu bệt Tài cực dài (>9), dự đoán bẻ mạnh!");
      } else if (recentHistoryFull.endsWith("XXXXXXXXX")) {
          addPrediction("Reset Cầu/Bẻ Sâu", "T", 0.4, "Cầu bệt Xỉu cực dài (>9), dự đoán bẻ mạnh!");
      }
  }

  analysis.rawPredictions.sort((a, b) => b.confidence - a.confidence);

  let voteTai = 0;
  let voteXiu = 0;

  const numberOfTopPredictions = Math.min(analysis.rawPredictions.length, 5);
  const topPredictions = analysis.rawPredictions.slice(0, numberOfTopPredictions);

  topPredictions.forEach(p => {
    if (p.predict === 'T') {
      voteTai += p.confidence;
    } else if (p.predict === 'X') {
      voteXiu += p.confidence;
    }
  });

  if (voteTai === 0 && voteXiu === 0) {
      finalPrediction = "?";
      combinedConfidence = 0;
  } else if (voteTai > voteXiu * 1.3) {
      finalPrediction = "T";
      combinedConfidence = voteTai / (voteTai + voteXiu);
  } else if (voteXiu > voteTai * 1.3) {
      finalPrediction = "X";
      combinedConfidence = voteXiu / (voteTai + voteXiu);
  } else {
      if (analysis.rawPredictions.length > 0) {
          finalPrediction = analysis.rawPredictions[0].predict;
          combinedConfidence = analysis.rawPredictions[0].confidence;
      } else {
          finalPrediction = "?";
          combinedConfidence = 0;
      }
  }

  const minOutputConfidence = 0.55;
  const maxOutputConfidence = 0.92;
  const originalMinConfidence = 0;
  const originalMaxConfidence = 1;

  let normalizedConfidence = Math.min(Math.max(combinedConfidence, originalMinConfidence), originalMaxConfidence);
  let finalMappedConfidence = ((normalizedConfidence - originalMinConfidence) / (originalMaxConfidence - originalMinConfidence)) * (maxOutputConfidence - minOutputConfidence) + minOutputConfidence;
  finalMappedConfidence = Math.min(Math.max(finalMappedConfidence, minOutputConfidence), maxOutputConfidence);
  
  analysis.finalPrediction = finalPrediction;
  analysis.confidence = finalMappedConfidence;

  analysis.predictionDetails = analysis.rawPredictions.map(p =>
    `${p.strategy}: ${p.predict} (Conf: ${(p.confidence * 100).toFixed(1)}%) - ${p.detail || ''}`
  );

  return analysis;
}

function updateStrategyWeight(strategyName, predictedResult, actualResult) {
  const strategyInfo = allPatternStrategies.find(p => p.name === strategyName);
  const effectiveStrategyName = strategyInfo ? strategyInfo.strategyGroup : strategyName;

  if (!predictionPerformance[effectiveStrategyName]) {
    predictionPerformance[effectiveStrategyName] = { correct: 0, total: 0 };
  }
  predictionPerformance[effectiveStrategyName].total++;

  if (predictedResult === actualResult) {
    predictionPerformance[effectiveStrategyName].correct++;
  }

  const { correct, total } = predictionPerformance[effectiveStrategyName];
  if (total >= 5) {
    const accuracy = correct / total;
    const adjustmentFactor = 0.05;

    if (accuracy > 0.6) {
      strategyWeights[effectiveStrategyName] = Math.min(strategyWeights[effectiveStrategyName] + adjustmentFactor, 2.5);
    } else if (accuracy < 0.4) {
      strategyWeights[effectiveStrategyName] = Math.max(strategyWeights[effectiveStrategyName] - adjustmentFactor, 0.5);
    }
  }
}

const messagesToSend = [
  [1, "MiniGame", "SC_thataoduocko112233", "112233", {
    "info": "{\"ipAddress\":\"2402:800:62cd:ef90:a445:40de:a24a:765e\",\"userId\":\"1a46e9cd-135d-4f29-9cd5-0b61bd2fb2a9\",\"username\":\"SC_thataoduocko112233\",\"timestamp\":1752257356729,\"refreshToken\":\"fe70e712cf3c4737a4ae22cbb3700c8e.f413950acf984ed6b373906f83a4f796\"}",
    "signature": "16916AC7F4F163CD00B319824B5B90FFE11BC5E7D232D58E7594C47E271A5CDE0492BB1C3F3FF20171B3A344BEFEAA5C4E9D28800CF18880FEA6AC3770016F2841FA847063B80AF8C8A747A689546CE75E99A7B559612BC30FBA5FED9288B69013C099FD6349ABC2646D5ECC2D5B2A1C5A9817FE5587844B41C752D0A0F6F304"
  }],
  [6, "MiniGame", "taixiuPlugin", { cmd: 1005 }],
  [6, "MiniGame", "lobbyPlugin", { cmd: 10001 }]
];

function connectWebSocket() {
  const ws = new WebSocket("wss://websocket.azhkthg1.net/websocket?token=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJhbW91bnQiOjAsInVzZXJuYW1lIjoiU0NfYXBpc3Vud2luMTIzIn0.hgrRbSV6vnBwJMg9ZFtbx3rRu9mX_hZMZ_m5gMNhkw0", {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Origin": "https://play.sun.win"
    }
  });

  ws.on('open', () => {
    console.log('[LOG] WebSocket kết nối');
    messagesToSend.forEach((msg, i) => {
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(msg));
        }
      }, i * 600);
    });

    setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 15000);
  });

  ws.on('pong', () => console.log('[LOG] Ping OK'));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (Array.isArray(data) && typeof data[1] === 'object') {
        const cmd = data[1].cmd;

        if (cmd === 1008 && data[1].sid) {
          if (lastRawPredictions.length > 0 && patternHistory.length > 0 && lastKnownResultSessionId !== null) {
              const actualResultOfPreviousSession = patternHistory[patternHistory.length - 1];
              console.log(`[LOG HỌC HỎI] Cập nhật trọng số cho phiên ${lastKnownResultSessionId} với kết quả: ${actualResultOfPreviousSession}`);
              lastRawPredictions.forEach(pred => {
                  updateStrategyWeight(pred.strategy, pred.predict, actualResultOfPreviousSession);
              });
              lastRawPredictions = [];
          }
          currentSessionId = data[1].sid;
          currentData.phien_hien_tai = currentSessionId;
          console.log(`[LOG] Cập nhật phiên hiện tại: ${currentData.phien_hien_tai}`);
        }

        if (cmd === 1003 && data[1].gBB) {
          const { d1, d2, d3 } = data[1];
          const total = d1 + d2 + d3;
          const actualResult = total > 10 ? "T" : "X";

          patternHistory.push(actualResult);
          if (patternHistory.length > 200) {
            patternHistory.shift();
          }
          diceHistory.push({ d1, d2, d3, total });
          if (diceHistory.length > 200) {
            diceHistory.shift();
          }

          const predictionResult = analyzeAndPredict(patternHistory, diceHistory);
          lastRawPredictions = predictionResult.rawPredictions;

          currentData = {
            phien_truoc: currentSessionId,
            ket_qua: (actualResult === "T" ? "Tài" : "Xỉu"),
            Dice: [d1, d2, d3],
            phien_hien_tai: currentSessionId !== null ? currentSessionId + 1 : null,
            du_doan: (predictionResult.finalPrediction === "T" ? "Tài" : (predictionResult.finalPrediction === "X" ? "Xỉu" : predictionResult.finalPrediction)),
            do_tin_cay: `${(predictionResult.confidence * 100).toFixed(2)}%`,
            cau: predictionResult.predictionDetails.join('; '),
            ngay: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
            Id: "@NguyenTung2029"
          };
          
          lastKnownResultSessionId = currentSessionId;

          console.log(`[LOG] Phiên ${currentData.phien_truoc} → ${d1}-${d2}-${d3} = ${total} (${currentData.ket_qua})`);
          console.log(`[LOG] Dự đoán P.${currentData.phien_hien_tai}: ${currentData.du_doan} (${currentData.do_tin_cay})`);
          console.log(`[LOG] Chi tiết phân tích: ${currentData.cau}`);
        }
      }
    } catch (err) {
      console.error('[ERROR] Lỗi xử lý dữ liệu:', err.message);
    }
  });

  ws.on('close', () => {
    console.log('[WARN] WebSocket mất kết nối. Đang thử lại sau 2.5s...');
    currentSessionId = null; 
    setTimeout(connectWebSocket, 2500);
  });

  ws.on('error', (err) => {
    console.error('[ERROR] WebSocket lỗi:', err.message);
  });
}

app.get('/taixiu', (req, res) => res.json(currentData));

app.get('/', (req, res) => {
  res.send(`<h2>Sunwin Tài Xỉu API</h2><p><a href="/taixiu">Xem kết quả JSON</a></p>`);
});

connectWebSocket();

app.listen(PORT, () => {
  console.log(`[INFO] Server đang chạy trên cổng ${PORT}`);
});
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
const PORT = process.env.PORT || 5000;

let currentData = {
  "phien_truoc": null, // Sẽ được cập nhật từ currentSessionId
  "ket_qua": "",
  "Dice": [],
  "phien_hien_tai": null, // Sẽ là phien_truoc + 1
  "du_doan": "",
  "do_tin_cay": "",
  "cau": "",
  "ngay": "",
  "Id": "@NguyenTung2029"
};

let currentSessionId = null; // Biến này sẽ lưu ID của phiên hiện tại đang chạy/chờ kết quả, được lấy từ cmd: 1008
let lastKnownResultSessionId = null; // Lưu ID của phiên cuối cùng đã có kết quả (dùng để cập nhật trọng số)

let patternHistory = []; // Lưu dãy T/X gần nhất (lên đến 200 phiên)
let diceHistory = [];    // Lưu lịch sử các mặt xúc xắc chi tiết
let lastRawPredictions = []; // Lưu trữ các dự đoán thô của phiên trước để cập nhật trọng số chính xác hơn

let predictionPerformance = {}; // { strategyName: { correct: 0, total: 0 } }

// Các trọng số này sẽ tự động điều chỉnh theo thời gian dựa trên hiệu suất
// Cố định tên nhóm chiến lược để trọng số được học hỏi và áp dụng nhất quán
let strategyWeights = {
    // Trọng số ban đầu cho các loại mẫu cầu chung
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
    "Cầu Lặp Chuỗi Khác": 1.0, // Thêm nhóm này
    // Trọng số cho các chiến lược đặc biệt không thuộc nhóm mẫu
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

// --- HÀM TẠO MẪU TỰ ĐỘNG ĐỂ ĐẠT 1000+ MẪU ---
function generateCommonPatterns() {
    let patterns = [];

    // 1. Cầu Bệt (Streaks): TTT... và XXX... (từ 3 đến 20 lần)
    for (let i = 3; i <= 20; i++) {
        patterns.push({
            name: `Cầu Bệt Tài (${i})`,
            pattern: "T".repeat(i),
            predict: "T",
            conf: 0.05 + (i * 0.005), // Conf tăng theo độ dài, nhỏ hơn để không quá cao
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

    // 2. Cầu 1-1 (Alternating): TXT... và XTX... (từ 3 đến 20 phiên)
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

    // 3. Cầu Lặp lại cơ bản (2-1, 2-2, 3-1, 3-2, 3-3, 4-1, 4-2, 4-3, 4-4)
    // Tăng số lần lặp để có nhiều mẫu hơn
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
        // Lặp từ 1 đến 5 lần để tạo thêm mẫu
        for (let numRepeats = 1; numRepeats <= 5; numRepeats++) {
            let currentPattern = patternInfo.base.repeat(numRepeats);
            let predictChar = patternInfo.base[0]; // Dự đoán theo ký tự đầu tiên của mẫu cơ sở

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

    // 4. Cầu Đối Xứng (Symmetric) và Đảo Ngược (Inverse)
    // Thêm các biến thể đối xứng và đảo ngược dài hơn
    const symmetricAndInversePatterns = [
        { base: "TX", predict: "T", group: "Cầu Đối Xứng" },
        { base: "XT", predict: "X", group: "Cầu Đối Xứng" },
        { base: "TXXT", predict: "T", group: "Cầu Đối Xứng" },
        { base: "XTTX", predict: "X", group: "Cầu Đối Xứng" },
        { base: "TTXT", predict: "X", group: "Cầu Đảo Ngược" },
        { base: "XXTX", predict: "T", group: "Cầu Đảo Ngược" },
        // Thêm các mẫu phức tạp hơn cho đối xứng
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
        // Thêm một số mẫu đối xứng AABB... và đảo ngược AABBCC -> CCBBAA
        if (patternInfo.base.length === 2) {
            let patternABBA = patternInfo.base + patternInfo.base.split('').reverse().join(''); // ABBA
            patterns.push({
                name: `${patternInfo.group} (${patternABBA})`,
                pattern: patternABBA,
                predict: patternInfo.base[0],
                conf: 0.15,
                minHistory: patternABBA.length,
                strategyGroup: patternInfo.group
            });
            let patternABCCBA = patternInfo.base.repeat(2) + patternInfo.base.split('').reverse().join('').repeat(2); // ABAB BABA
            if (patternABCCBA.length <= 10) { // Giới hạn độ dài để không quá lớn
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

    // 5. Cầu Ziczac Ngắn (Short unpredictable bursts)
    const shortZiczacPatterns = [
        { pattern: "TTX", predict: "T" }, { pattern: "XXT", predict: "X" },
        { pattern: "TXT", predict: "X" }, { pattern: "XTX", predict: "T" },
        { pattern: "TXX", predict: "X" }, { pattern: "XTT", predict: "T" },
        { pattern: "TTXX", predict: "T" }, { pattern: "XXTT", predict: "X" },
        { pattern: "TXTX", predict: "T" }, { pattern: "XTXT", predict: "X" },
        { pattern: "XTTX", predict: "X" }, { pattern: "TXXT", predict: "T" } // Các mẫu 4 ngắn
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
    
    // Tăng cường số lượng bằng các mẫu lặp lại phức tạp hơn (ví dụ AABBAA)
    // Mẫu lặp lại 2 lần của các mẫu cơ bản ngắn hơn
    const complexRepeats = ["TTX", "XXT", "TXT", "TXX", "XTT"];
    complexRepeats.forEach(base => {
        for (let i = 2; i <= 4; i++) { // Lặp từ 2 đến 4 lần
            const currentPattern = base.repeat(i);
            if (currentPattern.length <= 15) { // Giới hạn độ dài
                patterns.push({
                    name: `Cầu Lặp Chuỗi Khác (${base} x${i})`,
                    pattern: currentPattern,
                    predict: base[0],
                    conf: 0.07 + (i * 0.01),
                    minHistory: currentPattern.length,
                    strategyGroup: "Cầu Lặp Chuỗi Khác" // Nhóm mới
                });
            }
        }
    });

    return patterns;
}

const allPatternStrategies = generateCommonPatterns();
console.log(`[Khởi tạo] Tổng số mẫu cầu đã tạo: ${allPatternStrategies.length} (Mục tiêu 1000 mẫu được tạo linh hoạt)`);

// Kiểm tra để đảm bảo tất cả các nhóm chiến lược trong allPatternStrategies
// đều có trọng số ban đầu trong strategyWeights
allPatternStrategies.forEach(pattern => {
    if (strategyWeights[pattern.strategyGroup] === undefined) {
        strategyWeights[pattern.strategyGroup] = 1.0; // Khởi tạo trọng số mặc định
        predictionPerformance[pattern.strategyGroup] = { correct: 0, total: 0 };
    }
});


// === Thuật toán dự đoán nâng cao ===
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

  const recentHistoryFull = history.join(''); // Toàn bộ lịch sử dưới dạng chuỗi
  const recent50 = history.slice(-50).join('');
  const recent20 = history.slice(-20).join('');
  const recent10 = history.slice(-10).join('');

  const addPrediction = (strategyName, predict, confMultiplier, detail, strategyGroup = null) => {
    // Đảm bảo strategyName có trong predictionPerformance
    if (!predictionPerformance[strategyName]) {
        predictionPerformance[strategyName] = { correct: 0, total: 0 };
    }
    // Sử dụng trọng số của nhóm chiến lược nếu được cung cấp, nếu không thì dùng tên chiến lược
    const effectiveStrategyName = strategyGroup || strategyName;
    if (strategyWeights[effectiveStrategyName] === undefined) {
        strategyWeights[effectiveStrategyName] = 1.0; // Khởi tạo nếu chưa có
    }
    const weight = strategyWeights[effectiveStrategyName];
    const confidence = confMultiplier * weight;
    analysis.rawPredictions.push({ strategy: strategyName, predict, confidence, detail, strategyGroup: effectiveStrategyName });
  };

  // --- Áp dụng tất cả các mẫu cầu đã định nghĩa (được tạo tự động) ---
  for (const p of allPatternStrategies) {
    if (history.length >= p.minHistory) {
        let targetHistoryString;
        // Chọn đoạn lịch sử phù hợp với độ dài của mẫu
        if (p.minHistory <= 10) targetHistoryString = recent10;
        else if (p.minHistory <= 20) targetHistoryString = recent20;
        else if (p.minHistory <= 50) targetHistoryString = recent50;
        else targetHistoryString = recentHistoryFull;

        if (targetHistoryString.endsWith(p.pattern)) {
            addPrediction(p.name, p.predict, p.conf, `Phát hiện: ${p.name}`, p.strategyGroup);
        }
    }
  }

  // --- Chiến lược Bẻ cầu thông minh (khi cầu bệt/1-1 dài bất thường) ---
  if (history.length >= 7) {
    // Bẻ bệt Tài
    if (recentHistoryFull.endsWith("TTTTTTT")) {
      addPrediction("Bẻ cầu bệt dài", "X", 0.35, "Cầu bệt Tài quá dài (>7), dự đoán bẻ cầu");
    } else if (recentHistoryFull.endsWith("XXXXXXX")) {
      addPrediction("Bẻ cầu bệt dài", "T", 0.35, "Cầu bệt Xỉu quá dài (>7), dự đoán bẻ cầu");
    }

    // Bẻ cầu 1-1 khi quá dài (ví dụ: 8 phiên 1-1)
    if (recentHistoryFull.endsWith("XTXTXTXT")) {
        addPrediction("Bẻ cầu 1-1 dài", "X", 0.3, "Cầu 1-1 quá dài (>8), dự đoán bẻ sang Xỉu");
    } else if (recentHistoryFull.endsWith("TXTXTXTX")) {
        addPrediction("Bẻ cầu 1-1 dài", "T", 0.3, "Cầu 1-1 quá dài (>8), dự đoán bẻ sang Tài");
    }
  }

  // --- Chiến lược: Phân tích xu hướng (trong 20-50 phiên gần nhất) ---
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


  // --- Chiến lược: Phân tích Xúc Xắc và Tổng Điểm Cụ Thể ---
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

    if (maxCount >= 4) { // Nếu một tổng điểm xuất hiện ít nhất 4 lần trong 10 phiên
        const predict = mostFrequentTotal > 10 ? "T" : "X";
        addPrediction("Xu hướng tổng điểm", predict, 0.15, `Tổng điểm ${mostFrequentTotal} xuất hiện nhiều trong 10 phiên gần nhất`);
    }

    if (lastResult.d1 === lastResult.d2 && lastResult.d2 === lastResult.d3) {
        const predict = (lastResult.d1 <= 3) ? "T" : "X"; // Bộ ba Tài (4,5,6) thì bẻ Xỉu, bộ ba Xỉu (1,2,3) thì bẻ Tài
        addPrediction("Bộ ba", predict, 0.25, `Phát hiện bộ ba ${lastResult.d1}, dự đoán bẻ cầu`);
    }

    if (total === 10) {
        addPrediction("Điểm 10", "X", 0.08, "Tổng 10 (Xỉu) vừa ra, thường là điểm dao động hoặc bẻ cầu");
    } else if (total === 11) {
        addPrediction("Điểm 11", "T", 0.08, "Tổng 11 (Tài) vừa ra, thường là điểm dao động hoặc bẻ cầu");
    }
  }

  // --- Chiến lược: "Reset Cầu" hoặc "Bẻ Sâu" ---
  // Áp dụng khi cầu đã quá dài hoặc quá loạn, không có mẫu rõ ràng
  if (history.length > 20) {
      const last10 = history.slice(-10);
      const taiIn10 = last10.filter(r => r === 'T').length;
      const xiuIn10 = last10.filter(r => r === 'X').length;

      // Nếu cầu quá loạn (số T và X gần như cân bằng trong 10 phiên gần nhất)
      if (Math.abs(taiIn10 - xiuIn10) <= 2) {
          // Chỉ áp dụng nếu không có dự đoán mạnh từ các chiến lược khác
          if (analysis.rawPredictions.length === 0 || analysis.rawPredictions[0].confidence < 0.2) {
              const lastResult = history[history.length - 1];
              const predict = (lastResult === 'T' ? 'X' : 'T');
              addPrediction("Reset Cầu/Bẻ Sâu", predict, 0.28, "Cầu đang loạn hoặc khó đoán, dự đoán reset.");
          }
      }
      // Nếu có cầu bệt cực dài (ví dụ: > 9 phiên) mà chưa bị bẻ
      if (recentHistoryFull.endsWith("TTTTTTTTT")) { // 9 Tài liên tiếp
          addPrediction("Reset Cầu/Bẻ Sâu", "X", 0.4, "Cầu bệt Tài cực dài (>9), dự đoán bẻ mạnh!");
      } else if (recentHistoryFull.endsWith("XXXXXXXXX")) { // 9 Xỉu liên tiếp
          addPrediction("Reset Cầu/Bẻ Sâu", "T", 0.4, "Cầu bệt Xỉu cực dài (>9), dự đoán bẻ mạnh!");
      }
  }


  // --- KẾT HỢP CÁC DỰ ĐOÁN VÀ TÍNH ĐỘ TIN CẬY CUỐI CÙNG ---
  // Sắp xếp các dự đoán theo độ tin cậy giảm dần
  analysis.rawPredictions.sort((a, b) => b.confidence - a.confidence);

  let voteTai = 0;
  let voteXiu = 0;

  // Lấy 3-5 dự đoán hàng đầu để tính tổng độ tin cậy (có thể điều chỉnh số lượng này)
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
      combinedConfidence = 0; // Sẽ được map lên 0.55 sau
  } else if (voteTai > voteXiu * 1.3) { // Tài mạnh hơn 30%
      finalPrediction = "T";
      combinedConfidence = voteTai / (voteTai + voteXiu);
  } else if (voteXiu > voteTai * 1.3) { // Xỉu mạnh hơn 30%
      finalPrediction = "X";
      combinedConfidence = voteXiu / (voteTai + voteXiu);
  } else {
      // Nếu không có dự đoán nào vượt trội rõ rệt
      if (analysis.rawPredictions.length > 0) {
          // Ưu tiên dự đoán từ chiến lược có độ tin cậy cao nhất trong danh sách đã sắp xếp
          finalPrediction = analysis.rawPredictions[0].predict;
          combinedConfidence = analysis.rawPredictions[0].confidence;
      } else {
          finalPrediction = "?";
          combinedConfidence = 0; // Trường hợp không có bất kỳ dự đoán nào
      }
  }

  // --- ÁNH XẠ ĐỘ TIN CẬY ĐỂ NẰM TRONG KHOẢNG [55%, 92%] ---
  const minOutputConfidence = 0.55; // 55%
  const maxOutputConfidence = 0.92; // 92%
  const originalMinConfidence = 0;   // Giả định độ tin cậy gốc có thể từ 0
  const originalMaxConfidence = 1;   // Giả định độ tin cậy gốc có thể đến 1

  // Chuẩn hóa combinedConfidence về khoảng [0, 1] nếu nó có thể vượt quá do tổng trọng số
  let normalizedConfidence = Math.min(Math.max(combinedConfidence, originalMinConfidence), originalMaxConfidence);

  // Ánh xạ tuyến tính từ [originalMinConfidence, originalMaxConfidence] sang [minOutputConfidence, maxOutputConfidence]
  let finalMappedConfidence = ((normalizedConfidence - originalMinConfidence) / (originalMaxConfidence - originalMinConfidence)) * (maxOutputConfidence - minOutputConfidence) + minOutputConfidence;

  // Đảm bảo không vượt quá giới hạn
  finalMappedConfidence = Math.min(Math.max(finalMappedConfidence, minOutputConfidence), maxOutputConfidence);
  
  analysis.finalPrediction = finalPrediction;
  analysis.confidence = finalMappedConfidence;

  // Ghi lại chi tiết các dự đoán đã góp phần
  analysis.predictionDetails = analysis.rawPredictions.map(p =>
    `${p.strategy}: ${p.predict} (Conf: ${(p.confidence * 100).toFixed(1)}%) - ${p.detail || ''}`
  );

  return analysis;
}

/**
 * Cập nhật trọng số của các chiến lược dựa trên kết quả thực tế.
 * @param {string} strategyName Tên chiến lược đã đưa ra dự đoán.
 * @param {string} predictedResult Kết quả mà chiến lược đã dự đoán ('T' hoặc 'X').
 * @param {string} actualResult Kết quả thực tế ('T' hoặc 'X').
 */
function updateStrategyWeight(strategyName, predictedResult, actualResult) {
  // Tìm strategyGroup từ tên chiến lược (nếu có)
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
  if (total >= 5) { // Chỉ điều chỉnh sau một số lần thử nhất định để có đủ dữ liệu
    const accuracy = correct / total;
    const adjustmentFactor = 0.05; // Hệ số điều chỉnh nhỏ

    // Giới hạn trọng số từ 0.5 đến 2.5 để tránh quá cao hoặc quá thấp
    if (accuracy > 0.6) { // Nếu chiến lược hoạt động tốt
      strategyWeights[effectiveStrategyName] = Math.min(strategyWeights[effectiveStrategyName] + adjustmentFactor, 2.5);
    } else if (accuracy < 0.4) { // Nếu chiến lược hoạt động kém
      strategyWeights[effectiveStrategyName] = Math.max(strategyWeights[effectiveStrategyName] - adjustmentFactor, 0.5);
    }
  }
  // console.log(`[HỌC HỎI] Chiến lược: ${effectiveStrategyName}, Độ chính xác: ${(correct/total * 100).toFixed(2)}%, Trọng số mới: ${strategyWeights[effectiveStrategyName].toFixed(2)}`);
}

// ================== KẾT NỐI VÀ XỬ LÝ DỮ LIỆU =====================

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

        // Khi có phiên mới sắp bắt đầu (sid của phiên tiếp theo) - cmd: 1008
        // Đây là nơi chúng ta lấy ID phiên chính xác
        if (cmd === 1008 && data[1].sid) {
          // data[1].sid là ID của phiên SẮP TỚI
          // Nếu có ID phiên trước đã hoàn tất (tức là đã có kết quả), thì cập nhật trọng số
          if (lastRawPredictions.length > 0 && patternHistory.length > 0 && lastKnownResultSessionId !== null) {
              const actualResultOfPreviousSession = patternHistory[patternHistory.length - 1];
              console.log(`[LOG HỌC HỎI] Cập nhật trọng số cho phiên ${lastKnownResultSessionId} với kết quả: ${actualResultOfPreviousSession}`);
              lastRawPredictions.forEach(pred => {
                  updateStrategyWeight(pred.strategy, pred.predict, actualResultOfPreviousSession);
              });
              lastRawPredictions = []; // Xóa dự đoán thô sau khi đã cập nhật
          }
          currentSessionId = data[1].sid; // LƯU ID của phiên hiện tại đang chờ kết quả vào biến này
          // Cập nhật phien_hien_tai ngay khi nhận được cmd 1008 để nó có thể được hiển thị sớm nhất
          // Đây là phiên mà chúng ta sẽ dự đoán kết quả
          currentData.phien_hien_tai = currentSessionId;
          console.log(`[LOG] Cập nhật phiên hiện tại: ${currentData.phien_hien_tai}`);
        }

        // Khi có kết quả phiên (gBB) - cmd: 1003
        if (cmd === 1003 && data[1].gBB) {
          const { d1, d2, d3 } = data[1]; // Bỏ 'sid' khỏi đây vì nó không có trong gBB payload
          const total = d1 + d2 + d3;
          const actualResult = total > 10 ? "T" : "X";

          // Cập nhật lịch sử
          patternHistory.push(actualResult);
          if (patternHistory.length > 200) {
            patternHistory.shift();
          }
          diceHistory.push({ d1, d2, d3, total });
          if (diceHistory.length > 200) {
            diceHistory.shift();
          }

          // Phân tích và dự đoán cho phiên TIẾP THEO (dựa trên lịch sử vừa cập nhật)
          const predictionResult = analyzeAndPredict(patternHistory, diceHistory);
          lastRawPredictions = predictionResult.rawPredictions; // Lưu dự đoán thô của phiên MỚI này

          // Cập nhật currentData
          currentData = {
            phien_truoc: currentSessionId, // ID của phiên VỪA KẾT THÚC (chính là currentSessionId trước đó)
            ket_qua: (actualResult === "T" ? "Tài" : "Xỉu"),
            Dice: [d1, d2, d3],
            // phien_hien_tai sẽ được cập nhật bởi cmd: 1008 tiếp theo
            phien_hien_tai: currentSessionId !== null ? currentSessionId + 1 : null,
            du_doan: (predictionResult.finalPrediction === "T" ? "Tài" : (predictionResult.finalPrediction === "X" ? "Xỉu" : predictionResult.finalPrediction)),
            do_tin_cay: `${(predictionResult.confidence * 100).toFixed(2)}%`,
            cau: predictionResult.predictionDetails.join('; '),
            ngay: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
            Id: "@NguyenTung2029"
          };
          
          lastKnownResultSessionId = currentSessionId; // Lưu lại ID của phiên vừa có kết quả từ currentSessionId

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
    // Reset currentSessionId khi mất kết nối để tránh dùng SID cũ
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

connectWebSocket(); // Khởi động kết nối WebSocket khi ứng dụng bắt đầu

app.listen(PORT, () => {
  console.log(`[INFO] Server đang chạy trên cổng ${PORT}`);
});

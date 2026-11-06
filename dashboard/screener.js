window.SCREENER = [
  {
    "date": "2026-11-06",
    "runAt": "2026-11-06 15:10",
    "count": 2,
    "criteria": {
      "gain": "2.5%-7%",
      "turnover": "2.5%-20%",
      "cap": "20亿-500亿",
      "volRatio": "≥1.5",
      "yang": "≥2连阳",
      "gain20": "≤25%（近 20 日）",
      "aboveAvg": "≥95% 时间在分时均线上",
      "exclude": "创业板/科创板/北交所/ST/退市"
    },
    "list": [
      {
        "code": "600038",
        "name": "中直股份",
        "industry": "航空装备Ⅱ",
        "price": 28.77,
        "gain": 5.93,
        "turnover": 3.7,
        "volRatio": 3.65,
        "cap": 236,
        "yang": 5,
        "gain20": 1.76,
        "aboveRate": 99,
        "sector": ""
      },
      {
        "code": "002611",
        "name": "东方精工",
        "industry": "专用设备",
        "price": 13.91,
        "gain": 3.96,
        "turnover": 5.82,
        "volRatio": 2.14,
        "cap": 169,
        "yang": 4,
        "gain20": -1.69,
        "aboveRate": 98,
        "sector": ""
      }
    ],
    "warnings": []
  },
  {
    "date": "2026-11-05",
    "runAt": "2026-11-05 15:10",
    "count": 5,
    "criteria": {
      "gain": "2.5%-7%",
      "turnover": "2.5%-20%",
      "cap": "20亿-500亿",
      "volRatio": "≥1.5",
      "yang": "≥2连阳",
      "gain20": "≤25%（近 20 日）",
      "aboveAvg": "≥95% 时间在分时均线上",
      "exclude": "创业板/科创板/北交所/ST/退市"
    },
    "list": [
      {
        "code": "002389",
        "name": "航天彩虹",
        "industry": "航空装备Ⅱ",
        "price": 18.11,
        "gain": 6.53,
        "turnover": 3.9,
        "volRatio": 2.15,
        "cap": 178,
        "yang": 3,
        "gain20": -6.13,
        "aboveRate": 100,
        "sector": "",
        "verify": {
          "gain": 0.11,
          "hit": true,
          "price": 18.13,
          "code": "002389",
          "at": "2026-11-06",
          "open": 17.75,
          "openPct": -1.99,
          "buyRet": 2.14,
          "netRet": 1.94,
          "locked": false,
          "basis": "open-to-close",
          "by": "hist"
        }
      },
      {
        "code": "002984",
        "name": "森麒麟",
        "industry": "汽车零部件",
        "price": 13.17,
        "gain": 5.87,
        "turnover": 3.34,
        "volRatio": 2.27,
        "cap": 136,
        "yang": 4,
        "gain20": -4.45,
        "aboveRate": 100,
        "sector": "",
        "verify": {
          "gain": -1.82,
          "hit": false,
          "price": 12.93,
          "code": "002984",
          "at": "2026-11-06",
          "open": 12.89,
          "openPct": -2.13,
          "buyRet": 0.31,
          "netRet": 0.11,
          "locked": false,
          "basis": "open-to-close",
          "by": "hist"
        }
      },
      {
        "code": "600521",
        "name": "华海药业",
        "industry": "化学制药",
        "price": 17.87,
        "gain": 5.24,
        "turnover": 3.55,
        "volRatio": 1.86,
        "cap": 268,
        "yang": 4,
        "gain20": 3.92,
        "aboveRate": 100,
        "sector": "",
        "verify": {
          "gain": -1.45,
          "hit": false,
          "price": 17.61,
          "code": "600521",
          "at": "2026-11-06",
          "open": 17.44,
          "openPct": -2.41,
          "buyRet": 0.97,
          "netRet": 0.77,
          "locked": false,
          "basis": "open-to-close",
          "by": "hist"
        }
      },
      {
        "code": "002707",
        "name": "众信旅游",
        "industry": "旅游及景区",
        "price": 5.38,
        "gain": 4.06,
        "turnover": 2.86,
        "volRatio": 1.54,
        "cap": 53,
        "yang": 4,
        "gain20": 2.78,
        "aboveRate": 100,
        "sector": "消费",
        "verify": {
          "gain": -0.37,
          "hit": false,
          "price": 5.36,
          "code": "002707",
          "at": "2026-11-06",
          "open": 5.3,
          "openPct": -1.49,
          "buyRet": 1.13,
          "netRet": 0.93,
          "locked": false,
          "basis": "open-to-close",
          "by": "hist"
        }
      },
      {
        "code": "600821",
        "name": "金开新能",
        "industry": "电力",
        "price": 5.41,
        "gain": 3.24,
        "turnover": 2.67,
        "volRatio": 1.56,
        "cap": 106,
        "yang": 3,
        "gain20": -7.75,
        "aboveRate": 96,
        "sector": "",
        "verify": {
          "gain": 1.85,
          "hit": true,
          "price": 5.51,
          "code": "600821",
          "at": "2026-11-06",
          "open": 5.3,
          "openPct": -2.03,
          "buyRet": 3.96,
          "netRet": 3.75,
          "locked": false,
          "basis": "open-to-close",
          "by": "hist"
        }
      }
    ],
    "warnings": []
  },
  {
    "date": "2026-11-04",
    "runAt": "2026-11-04 15:10",
    "fault": true,
    "reason": "数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。通常是上游网络/接口临时故障，不是\"没有符合条件个股\"。故障恢复后下一交易日会自动补录。",
    "count": 0,
    "list": []
  },
  {
    "date": "2026-11-03",
    "runAt": "2026-11-03 15:10",
    "fault": true,
    "reason": "数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。通常是上游网络/接口临时故障，不是\"没有符合条件个股\"。故障恢复后下一交易日会自动补录。",
    "count": 0,
    "list": []
  },
  {
    "date": "2026-11-02",
    "runAt": "2026-11-02 15:10",
    "fault": true,
    "reason": "数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。通常是上游网络/接口临时故障，不是\"没有符合条件个股\"。故障恢复后下一交易日会自动补录。",
    "count": 0,
    "list": []
  },
  {
    "date": "2026-10-30",
    "runAt": "2026-10-30 15:10",
    "fault": true,
    "reason": "数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。通常是上游网络/接口临时故障，不是\"没有符合条件个股\"。故障恢复后下一交易日会自动补录。",
    "count": 0,
    "list": []
  },
  {
    "date": "2026-10-29",
    "runAt": "2026-10-29 15:10",
    "fault": true,
    "reason": "数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。通常是上游网络/接口临时故障，不是\"没有符合条件个股\"。故障恢复后下一交易日会自动补录。",
    "count": 0,
    "list": []
  },
  {
    "date": "2026-10-28",
    "runAt": "2026-10-28 15:10",
    "fault": true,
    "reason": "数据源（东财 push2delay 行情接口）在交易时段抓取失败，全市场 0 只，无法筛选。通常是上游网络/接口临时故障，不是\"没有符合条件个股\"。故障恢复后下一交易日会自动补录。",
    "count": 0,
    "list": []
  },
  {
    "date": "2026-10-27",
    "runAt": "2026-10-27 15:10",
    "count": 0,
    "criteria": {
      "gain": "2.5%-7%",
      "turnover": "2.5%-20%",
      "cap": "20亿-500亿",
      "volRatio": "≥1.5",
      "yang": "≥2连阳",
      "gain20": "≤25%（近 20 日）",
      "aboveAvg": "≥95% 时间在分时均线上",
      "exclude": "创业板/科创板/北交所/ST/退市"
    },
    "list": [],
    "warnings": [
      "分时获取失败 12 只"
    ]
  },
  {
    "date": "2026-10-26",
    "runAt": "2026-10-26 15:10",
    "count": 0,
    "criteria": {
      "gain": "2.5%-7%",
      "turnover": "2.5%-20%",
      "cap": "20亿-500亿",
      "volRatio": "≥1.5",
      "yang": "≥2连阳",
      "gain20": "≤25%（近 20 日）",
      "aboveAvg": "≥95% 时间在分时均线上",
      "exclude": "创业板/科创板/北交所/ST/退市"
    },
    "list": [],
    "warnings": []
  }
];

export function sampleSheets() {
  return [
    { name: "总览", rows: 1, columns: 1, values: [["翻译任务"]] },
    { name: "Language", rows: 5, columns: 7, values: [
      ["LanguageKey", "Source Text (old)", "Source Text", "WEIGHT", "EN (old)", "EN", "EN_AI"],
      ["Coin", "", "获得 {0} 金币", "1", "", "", "Get {0} coins"],
      ["Welcome", "", "你好", "1", "Hi", "Hello", "Welcome"],
      ["Color", "", "<color=#fff>{0}</color>", "1", "", "<color=#fff>Hello</color>", "<color=#fff>{0}</color>"],
      ["UnsafeAI", "", "剩余 %s 秒", "1", "", "", "Remaining seconds"],
    ] },
    { name: "FishCfg", rows: 4, columns: 16, values: [
      ["字段说明"],
      ["Id", "", "Name", "", "", "", "", "Desc", "", "", "", "", "Name_i18N", "Name_AI", "Desc_i18N", "Desc_AI"],
      ["", "", "Source Text", "WEIGHT", "EN (old)", "EN", "", "Source Text", "WEIGHT", "EN (old)", "EN", "", "", "", "", ""],
      ["fish1", "", "鲤鱼", "1", "", "Carp", "", "重量 {0}", "1", "", "", "", "Fish/Name", "Carp", "Fish/Desc", "Weight {0}"],
    ] },
  ];
}

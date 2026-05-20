Feature: 介面語系切換
  身為 EasyNote 使用者
  我希望能切換插件介面語言
  以便使用自己熟悉的語言操作

  Scenario Outline: 各語系正確顯示工具列文字
    When 我將語系切換為 "<lang>"
    Then 工具列繪圖群組名稱應為 "<name>"

    Examples:
      | lang | name    |
      | zh   | 插畫    |
      | en   | Drawing |

  Scenario Outline: 各語系都包含核心翻譯 key
    When 我將語系切換為 "<lang>"
    Then 翻譯 "tb.eraser.title" 的結果應為非空字串
    And 翻譯 "tb.undo.title" 的結果應為非空字串
    And 翻譯 "tb.redo.title" 的結果應為非空字串

    Examples:
      | lang  |
      | zh    |
      | zh-cn |
      | ja    |
      | ko    |
      | en    |

  Scenario: 不存在的翻譯 key 回傳 key 本身
    Given 目前語系為 "en"
    When 我查詢翻譯 "nonexistent.key.xyz"
    Then 翻譯結果應等於 "nonexistent.key.xyz"

  Scenario: 佔位符 {0} {1} 被對應參數替換
    Given 目前語系為 "zh"
    When 我以參數 "紅色" 和 "1" 查詢翻譯 "tb.color.title"
    Then 翻譯結果應包含 "紅色"
    And 翻譯結果應包含 "1"
    And 翻譯結果不應包含 "{0}"
    And 翻譯結果不應包含 "{1}"

  Scenario: 切換語系後翻譯立即生效
    Given 目前語系為 "zh"
    When 我查詢翻譯 "tb.group.draw"
    Then 翻譯結果應等於 "插畫"
    When 我將語系切換為 "en"
    And 我查詢翻譯 "tb.group.draw"
    Then 翻譯結果應等於 "Drawing"

Feature: 筆刷大小轉換
  身為 EasyNote 使用者
  我希望筆刷大小（px）能自動對應到 1 到 7 個標準階數
  以便在不同輸入裝置上有一致的筆刷手感

  Background:
    Given 標準筆刷共有 7 個階段

  Scenario Outline: 精確 px 值直接對應階數
    When 我設定筆刷大小為 <px> px
    Then 筆刷階數應為 <step>

    Examples:
      | px | step |
      | 2  | 1    |
      | 6  | 2    |
      | 12 | 3    |
      | 20 | 4    |
      | 30 | 5    |
      | 44 | 6    |
      | 60 | 7    |

  Scenario Outline: 非精確 px 值取最近的階數
    When 我設定筆刷大小為 <px> px
    Then 筆刷階數應為 <step>

    Examples:
      | px  | step |
      | 1   | 1    |
      | 4   | 1    |
      | 15  | 3    |
      | 55  | 7    |

  Scenario: 超出範圍的 px 值不應跳出有效階數
    When 我設定筆刷大小為 0 px
    Then 筆刷階數應介於 1 到 7 之間
    When 我設定筆刷大小為 999 px
    Then 筆刷階數應介於 1 到 7 之間

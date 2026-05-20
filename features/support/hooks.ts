import { After } from '@cucumber/cucumber';
import { setLang } from '../../i18n';

/**
 * 每個 Scenario 結束後重置語系為 zh，
 * 避免語系狀態在不同 Scenario 之間互相污染。
 */
After(function () {
    setLang('zh');
});

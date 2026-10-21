# 맞춤법 사전

앱의 맞춤법 검사(spell-worker.js)가 기기 안에서 쓰는 Hunspell 사전이다. 원본을 고치지 않고 gzip으로만 줄였다.
처음 검사할 때 한 번 받아 브라우저 저장소(IndexedDB `diary-spell`)에 두고, 그 뒤로는 인터넷 없이 쓴다.

| 파일 | 원본 | 판 | 사용 허가 |
|---|---|---|---|
| `ko.aff.gz`, `ko.dic.gz` | [hunspell-dict-ko](https://github.com/spellcheck-ko/hunspell-dict-ko) (npm `dictionary-ko` 2.0.0) | 0.7.94 | `LICENSE-ko.txt` |
| `en_US.aff.gz`, `en_US.dic.gz` | [SCOWL en_US](http://wordlist.sourceforge.net) (npm `dictionary-en` 4.0.0) | 2020.12.07 | `LICENSE-en_US.txt` |

사전을 바꾸면 `spell-worker.js`의 `DICT_VERSION`을 올린다 (그래야 기기에 저장된 옛 사전을 새로 받는다).

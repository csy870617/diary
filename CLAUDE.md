# 신앙일지 (Faith Log)

빌드 과정 없이 파일 그대로 GitHub Pages로 배포하는 웹앱이다 (https://csy870617.github.io/diary/).

## 배포
- 변경을 마치고 시험을 통과하면 **묻지 않고 바로 배포한다** (사용자 요청: "배포는 항상 자동으로").
  작업 브랜치 → PR → main에 squash 병합 → `.github/workflows/deploy.yml`이 GitHub Pages로 배포한다.
- 배포 뒤 `https://csy870617.github.io/diary/version.json`이 새 버전으로 바뀌었는지 확인한다.
- 배포할 때마다 버전을 올린다. `index.html`의 `app-version` 메타, `style.css?v=`, import map의 모든 `?v=`,
  `script.js?v=`, 그리고 `version.json`을 같은 값(예: `2026.10.21.3`)으로 맞춘다.
  앱은 화면을 다시 열 때 `version.json`과 견주어 새 버전이면 저절로 새로 고친다.
- 새 모듈 파일을 만들면 `index.html`의 import map에도 넣는다 (버전이 붙지 않으면 캐시에 남은 옛 파일과 섞인다).

## 글쓰기
- 코드 주석·커밋 메시지·PR 설명은 지금 코드처럼 쉬운 우리말로 쓴다.

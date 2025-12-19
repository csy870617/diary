// 구글 클라우드 콘솔에서 발급받은 정보를 입력했습니다.
export const GOOGLE_CONFIG = {
    // 1. OAuth 2.0 클라이언트 ID
    CLIENT_ID: '702745292814-1bhk4h09u5qbse75r69ebmcedoivi1du.apps.googleusercontent.com',
    
    // 2. API 키
    API_KEY: 'AIzaSyCM5zgBbmFq7_NnmQfNu2nKsU16RaR2ayc',
    
    // 3. 디스커버리 문서 (구글 드라이브 API 명세)
    DISCOVERY_DOC: 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest',
    
    // 4. 권한 범위 (이 앱이 생성한 파일만 접근하도록 제한)
    SCOPES: 'https://www.googleapis.com/auth/drive.file'
};

// 드라이브에 생성될 폴더 및 파일 이름
export const APP_FOLDER_NAME = 'FaithLog_Data'; 
export const DB_FILE_NAME = 'faith_log_db.json';
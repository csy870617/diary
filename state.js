export const state = {
    entries: [],
    allCategories: [
        { id: 'cat_default', name: '기본' },
        { id: 'cat_thanks', name: '감사' },
        { id: 'cat_meditation', name: '묵상' }
    ],
    categoryOrder: ['cat_default', 'cat_thanks', 'cat_meditation'],
    currentCategory: 'cat_default',
    
    // [추가] 주제가 수정된 시간을 기록 (초기값: 아주 옛날)
    categoryUpdatedAt: new Date(0).toISOString(),
    
    currentSortBy: 'created',
    currentSortOrder: 'desc',
    currentViewMode: 'default',
    isLoading: true,
    isEditMode: false,
    editingId: null,
    
    currentFontFamily: 'Pretendard',
    currentFontSize: 16,
    
    activeColorMode: 'foreColor',
    
    currentUser: null,
    contextTargetId: null,
    contextCatId: null,
    longPressTimer: null,
    lastFocusedEdit: null,
    
    touchStartX: 0,
    touchEndX: 0,
    wheelDebounceTimer: null,
    autoSaveTimer: null
};

// [수정] 카테고리 저장 시 '수정 시간'도 함께 저장
export function saveCategoriesToLocal() {
    const data = {
        categories: state.allCategories,
        order: state.categoryOrder,
        // 현재 시간을 수정 시간으로 기록
        updatedAt: state.categoryUpdatedAt || new Date().toISOString()
    };
    localStorage.setItem('faithCatData', JSON.stringify(data));
}

// [추가] 로컬에서 카테고리 불러오기
export function loadCategoriesFromLocal() {
    const localData = localStorage.getItem('faithCatData');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (parsed.categories && parsed.order) {
                state.allCategories = parsed.categories;
                state.categoryOrder = parsed.order;
                state.categoryUpdatedAt = parsed.updatedAt || new Date(0).toISOString();
            }
        } catch (e) {
            console.error("카테고리 로드 실패", e);
        }
    }
}
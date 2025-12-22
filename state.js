export const state = {
    entries: [],
    // 기본값: 설교, 묵상, 기도, 감사
    allCategories: [
        { id: 'cat_sermon', name: '설교' },
        { id: 'cat_meditation', name: '묵상' },
        { id: 'cat_prayer', name: '기도' },
        { id: 'cat_thanks', name: '감사' }
    ],
    categoryOrder: ['cat_sermon', 'cat_meditation', 'cat_prayer', 'cat_thanks'],
    currentCategory: 'cat_sermon',
    
    // 카테고리 수정 시간 (초기값 0)
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

export function saveCategoriesToLocal() {
    const data = {
        categories: state.allCategories,
        order: state.categoryOrder,
        updatedAt: state.categoryUpdatedAt || new Date().toISOString()
    };
    localStorage.setItem('faithCatData', JSON.stringify(data));
}

// [핵심] 앱 시작 시 로컬 데이터 불러오기
export function loadCategoriesFromLocal() {
    const localData = localStorage.getItem('faithCatData');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (parsed.categories && parsed.order) {
                state.allCategories = parsed.categories;
                state.categoryOrder = parsed.order;
                state.categoryUpdatedAt = parsed.updatedAt || new Date(0).toISOString();
                
                // 현재 선택된 카테고리가 유효한지 확인
                const exists = state.allCategories.find(c => c.id === state.currentCategory);
                if (!exists && state.categoryOrder.length > 0) {
                    state.currentCategory = state.categoryOrder[0];
                }
            }
        } catch (e) {
            console.error("카테고리 로드 실패", e);
        }
    }
}
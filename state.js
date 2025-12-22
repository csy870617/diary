export const state = {
    entries: [],
    // 기본 카테고리 설정
    allCategories: [
        { id: 'cat_sermon', name: '설교' },
        { id: 'cat_meditation', name: '묵상' },
        { id: 'cat_prayer', name: '기도' },
        { id: 'cat_thanks', name: '감사' }
    ],
    categoryOrder: ['cat_sermon', 'cat_meditation', 'cat_prayer', 'cat_thanks'],
    currentCategory: 'cat_sermon',
    
    // [중요] 초기 시간 값을 1970년 1월 1일로 설정하여 동기화 시 무조건 업데이트 받도록 함
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

export function loadCategoriesFromLocal() {
    const localData = localStorage.getItem('faithCatData');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (parsed.categories && parsed.order) {
                state.allCategories = parsed.categories;
                state.categoryOrder = parsed.order;
                // 저장된 시간이 없으면 0(아주 옛날)으로 처리
                state.categoryUpdatedAt = parsed.updatedAt || new Date(0).toISOString();
                
                // 현재 카테고리가 유효하지 않으면 첫 번째 탭 선택
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
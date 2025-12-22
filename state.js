export const state = {
    entries: [],
    // [수정] 요청하신 기본 카테고리 4개로 설정
    allCategories: [
        { id: 'cat_sermon', name: '설교' },
        { id: 'cat_meditation', name: '묵상' },
        { id: 'cat_prayer', name: '기도' },
        { id: 'cat_thanks', name: '감사' }
    ],
    // 순서도 이에 맞춰 설정
    categoryOrder: ['cat_sermon', 'cat_meditation', 'cat_prayer', 'cat_thanks'],
    
    // [수정] 첫 번째 탭(설교)을 기본 선택
    currentCategory: 'cat_sermon',
    
    // 카테고리 수정 시간 (동기화용)
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

// 카테고리 로컬 저장
export function saveCategoriesToLocal() {
    const data = {
        categories: state.allCategories,
        order: state.categoryOrder,
        updatedAt: state.categoryUpdatedAt || new Date().toISOString()
    };
    localStorage.setItem('faithCatData', JSON.stringify(data));
}

// 카테고리 로컬 불러오기
export function loadCategoriesFromLocal() {
    const localData = localStorage.getItem('faithCatData');
    if (localData) {
        try {
            const parsed = JSON.parse(localData);
            if (parsed.categories && parsed.order) {
                state.allCategories = parsed.categories;
                state.categoryOrder = parsed.order;
                state.categoryUpdatedAt = parsed.updatedAt || new Date(0).toISOString();
                
                // 불러온 뒤 현재 카테고리가 유효한지 확인하고, 없으면 첫번째로 설정
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
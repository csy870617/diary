export const state = {
    currentUser: null,
    currentCategory: 'sermon',
    entries: [],
    isLoading: true,
    isEditMode: false,
    editingId: null,
    currentFontSize: 16,
    currentFontFamily: 'Pretendard',
    currentSortBy: 'created',
    currentSortOrder: 'desc',
    currentViewMode: 'default',
    
    // UI 상태
    touchStartX: 0,
    touchEndX: 0,
    contextTargetId: null,
    contextCatId: null,
    lastFocusedEdit: null,
    activeColorMode: 'foreColor',
    
    // 타이머
    longPressTimer: null,
    autoSaveTimer: null,
    wheelDebounceTimer: null,

    // 카테고리
    allCategories: [],
    categoryOrder: []
};

// 초기 카테고리 설정
const initialCategories = [
    { id: 'sermon', name: '설교' },
    { id: 'meditation', name: '묵상' },
    { id: 'prayer', name: '기도' },
    { id: 'gratitude', name: '감사' }
];

state.allCategories = JSON.parse(localStorage.getItem('faithCategories')) || [...initialCategories];
state.categoryOrder = JSON.parse(localStorage.getItem('faithCatOrder')) || state.allCategories.map(c => c.id);

export function saveCategoriesToLocal() {
    localStorage.setItem('faithCategories', JSON.stringify(state.allCategories));
    localStorage.setItem('faithCatOrder', JSON.stringify(state.categoryOrder));
}
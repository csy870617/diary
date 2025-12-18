export function autoLink(text) {
    const div = document.createElement('div');
    div.innerHTML = text;
    
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const nodesToReplace = [];
    
    while(node = walker.nextNode()) {
        if(node.parentElement.tagName === 'A') continue; 
        if(node.nodeValue.match(/(https?:\/\/[^\s]+)/)) {
            nodesToReplace.push(node);
        }
    }
    
    nodesToReplace.forEach(node => {
        const span = document.createElement('span');
        span.innerHTML = node.nodeValue.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#2563EB; text-decoration:underline; pointer-events: auto !important; cursor: pointer;">$1</a>');
        node.parentElement.replaceChild(span, node);
        const parent = span.parentElement;
        while(span.firstChild) {
            parent.insertBefore(span.firstChild, span);
        }
        parent.removeChild(span);
    });
    
    return div.innerHTML;
}
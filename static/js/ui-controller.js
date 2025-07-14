// UI Controller for Dream Recorder
document.addEventListener('DOMContentLoaded', () => {
    // Input simulator buttons
    const singleTapBtn = document.getElementById('singleTapBtn');
    const doubleTapBtn = document.getElementById('doubleTapBtn');
    const holdBtn = document.getElementById('holdBtn');
    
    // Input simulator handlers
    singleTapBtn.addEventListener('click', () => simulateInput('single_tap'));
    doubleTapBtn.addEventListener('click', () => simulateInput('double_tap'));
    holdBtn.addEventListener('click', () => simulateInput('hold'));
    
    // Listen for state changes
    document.addEventListener('stateChange', (event) => {
        updateUIForState(event.detail.state);
    });
    
    // Initial UI state
    if (StateManager) {
        updateUIForState(StateManager.currentState);
    }
});

// Simulate input for development/testing
function simulateInput(eventType) {
    console.log(`Simulating input: ${eventType}`);
    if (StateManager) {
        StateManager.handleDeviceEvent(eventType);
    }
}

// Update UI based on state
function updateUIForState(state) {
    const container = document.querySelector('.container');
    
    // Remove all state classes
    container.classList.remove('clock', 'alarm_clock', 'alarm_setting_hour', 'alarm_setting_minute', 'alarm_triggered', 'recording', 'processing', 'playback', 'error');
    
    // Add current state class
    container.classList.add(state);
} 
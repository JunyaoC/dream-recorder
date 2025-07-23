// State manager for Dream Recorder
const StateManager = {
    // Possible states
    STATES: {
        STARTUP: 'startup',
        CLOCK: 'clock',
        ALARM_CLOCK: 'alarm_clock',  // Acts as hour setting mode
        ALARM_SETTING_HOUR: 'alarm_setting_hour',  // Kept for compatibility, same as ALARM_CLOCK
        ALARM_SETTING_MINUTE: 'alarm_setting_minute',
        ALARM_TRIGGERED: 'alarm_triggered',
        RECORDING: 'recording',
        PROCESSING: 'processing',
        PLAYBACK: 'playback',
        ERROR: 'error'
    },

    // Configuration (will be populated from server)
    config: {
    },

    // Input modes (kept for input simulator compatibility)
    MODES: {
        SINGLE_TAP: 'single_tap',
        DOUBLE_TAP: 'double_tap'
    },

    // Current state and mode
    currentState: 'startup',
    currentMode: 'single_tap',
    error: null,
    previousState: null,
    stateChangeCallbacks: [],
    playbackTimer: null,
    
    // Alarm clock settings
    alarmHour: 0,
    alarmMinute: 0,
    
    // Alarm audio element
    alarmHowl: null,

    // Initialize state manager
    async init() {
        try {
            const response = await fetch('/api/config');
            const config = await response.json();
            this.config.playbackDuration = config.playback_duration;
            this.config.logoFadeInDuration = config.logo_fade_in_duration;
            this.config.logoFadeOutDuration = config.logo_fade_out_duration;
            this.config.clockFadeInDuration = config.clock_fade_in_duration;
            this.config.clockFadeOutDuration = config.clock_fade_out_duration;
            this.config.transitionDelay = config.transition_delay;
        } catch (error) {
            console.error('Failed to fetch config:', error);
        }

        // Set initial state to STARTUP
        this.currentState = this.STATES.STARTUP;
        this.updateStatus();

        // Start the startup sequence
        this.startStartupSequence();
    },

    // Handle startup sequence
    startStartupSequence() {
        const logo = document.querySelector('.startup-logo');
        const clockDisplay = document.getElementById('clockDisplay');

        // Ensure clock is hidden
        clockDisplay.style.display = 'none';
        clockDisplay.style.opacity = '0';

        // Reset logo styles
        logo.style.opacity = '0';
        logo.style.display = 'block';
        logo.style.transition = 'none';
        
        // Force a reflow to ensure styles are applied
        logo.offsetHeight;
        
        // Start the sequence
        this.fadeInLogo(logo);
    },

    // Fade in the logo
    fadeInLogo(logo) {
        // Set up transition for fade in
        logo.style.transition = `opacity ${this.config.logoFadeInDuration}ms ease-out`;
        logo.style.opacity = '1';

        // After fade in, wait and then fade out
        setTimeout(() => {
            this.fadeOutLogo(logo);
        }, this.config.logoFadeInDuration + this.config.transitionDelay);
    },

    // Fade out the logo
    fadeOutLogo(logo) {
        // Set up transition for fade out
        logo.style.transition = `opacity ${this.config.logoFadeOutDuration}ms ease-out`;
        logo.style.opacity = '0';

        // After fade out completes, transition to CLOCK state
        setTimeout(() => {
            logo.style.display = 'none';
            this.updateState(this.STATES.CLOCK);
        }, this.config.logoFadeOutDuration);
    },

    // Update state
    async updateState(newState, errorMessage = null) {
        // Don't allow state changes during startup sequence
        if (this.currentState === this.STATES.STARTUP && newState !== this.STATES.CLOCK) {
            return;
        }

        // Clear any existing timers
        if (this.playbackTimer) {
            clearTimeout(this.playbackTimer);
            this.playbackTimer = null;
        }

        // Handle transitions
        this.handleStateTransition(newState);

        // Handle alarm audio BEFORE updating state
        if (this.currentState === this.STATES.ALARM_TRIGGERED && newState !== this.STATES.ALARM_TRIGGERED && this.alarmHowl) {
            console.log('Fading out alarm audio before state transition');
            this.alarmHowl.fade(1, 0, 1500); // 1000 means 1000 milliseconds (1 second) duration for the fade
            setTimeout(() => {
                this.alarmHowl.stop();
            }, 3000);
        }

        this.previousState = this.currentState;
        this.currentState = newState;
        this.error = errorMessage;
        this.updateStatus();
        
        // Handle icon animations based on state
        if (this.currentState === this.STATES.RECORDING) {
            IconAnimations.show(IconAnimations.TYPES.RECORDING);
        } else if (this.currentState === this.STATES.PROCESSING) {
            IconAnimations.show(IconAnimations.TYPES.GENERATING);
        } else if (this.currentState === this.STATES.ERROR) {
            IconAnimations.show(IconAnimations.TYPES.ERROR);
        } else {
            // Hide icons for all other states (STARTUP, CLOCK, PLAYBACK, etc.)
            IconAnimations.hideAll();
        }
        
        // Set up playback timer if entering playback state
        if (this.currentState === this.STATES.PLAYBACK) {
            this.playbackTimer = setTimeout(() => {
                this.updateState(this.STATES.CLOCK);
            }, this.config.playbackDuration * 1000); // Convert to milliseconds
        }
        
        // Handle alarm triggered state
        if (newState === this.STATES.ALARM_TRIGGERED) {
            console.log('Entering ALARM_TRIGGERED state');
            // Show clock (current time)
            if (window.Clock && !window.Clock.clockInterval) {
                window.Clock.init();
            }
            // Play alarm sound using Howler.js
            if (!this.alarmHowl) {
                this.alarmHowl = new Howl({
                    src: ['/static/audio/alarm.mp3'],
                    loop: true,
                    volume: 1.0
                });
            }
            this.alarmHowl.volume(0);
            this.alarmHowl.play();
            this.alarmHowl.fade(0, 1, 1000); // Fade in over 1s
        }
        
        // Notify all registered callbacks
        this.stateChangeCallbacks.forEach(callback => callback(this.currentState, this.previousState));
        
        // Emit state change event
        const event = new CustomEvent('stateChange', { 
            detail: { 
                state: this.currentState, 
                error: this.error,
                mode: this.currentMode
            } 
        });
        document.dispatchEvent(event);

        // Hide errorDiv if leaving ERROR state
        if (this.currentState !== this.STATES.ERROR && window.errorDiv) {
            window.errorDiv.style.display = 'none';
        }
    },

    // Handle state transitions
    handleStateTransition(newState) {
        const clockDisplay = document.getElementById('clockDisplay');
        const videoContainer = document.getElementById('videoContainer');
        const video = document.getElementById('generatedVideo');

        // Handle video container
        if (videoContainer) {
            if (newState === this.STATES.PLAYBACK) {
                // Show video container
                videoContainer.style.display = 'block';
                
                // Force a reflow to ensure transition works
                videoContainer.offsetHeight;
                
                // Fade in video container
                videoContainer.style.opacity = '1';
                
                // After container is visible, fade in video
                setTimeout(() => {
                    if (video) {
                        video.style.opacity = '1';
                        if (video.paused) {
                            video.play().catch(error => console.error('Error playing video:', error));
                        }
                    }
                }, this.config.transitionDelay);
            } else if (this.currentState === this.STATES.PLAYBACK) {
                // Fade out video first
                if (video) {
                    video.style.opacity = '0';
                }
                
                // Then fade out container
                videoContainer.style.opacity = '0';
                setTimeout(() => {
                    if (this.currentState !== this.STATES.PLAYBACK) {
                        videoContainer.style.display = 'none';
                        if (video) {
                            video.pause();
                            video.currentTime = 0;
                        }
                    }
                }, this.config.logoFadeOutDuration);
            }
        }

        // Handle clock display
        if (clockDisplay) {
            console.log(`Handling clock display for state: ${newState}`);
            const isAlarmState = [this.STATES.ALARM_CLOCK, this.STATES.ALARM_SETTING_HOUR, this.STATES.ALARM_SETTING_MINUTE].includes(newState);
            
            if (newState === this.STATES.CLOCK || newState === this.STATES.ALARM_TRIGGERED || isAlarmState) {
                // Fade in clock
                clockDisplay.style.transition = `opacity ${this.config.clockFadeInDuration}ms ease-out`;
                clockDisplay.style.display = 'block';
                // Force reflow
                clockDisplay.offsetHeight;
                clockDisplay.style.opacity = '1';
                clockDisplay.style.zIndex = '10'; // Below video when playing

                // Apply alarm clock styling if in any alarm state
                if (isAlarmState) {
                    clockDisplay.classList.add('alarm-mode');
                    
                    // Remove all alarm state classes first
                    clockDisplay.classList.remove('alarm-setting-hour', 'alarm-setting-minute');
                    
                    // Add specific state class
                    if (newState === this.STATES.ALARM_SETTING_HOUR) {
                        clockDisplay.classList.add('alarm-setting-hour');
                    } else if (newState === this.STATES.ALARM_SETTING_MINUTE) {
                        clockDisplay.classList.add('alarm-setting-minute');
                    }
                    
                    // Stop regular clock updates and show alarm time
                    if (window.Clock && window.Clock.clockInterval) {
                        window.Clock.cleanup();
                    }
                    this.updateAlarmDisplay();
                } else {
                    clockDisplay.classList.remove('alarm-mode', 'alarm-setting-hour', 'alarm-setting-minute');
                    // Resume regular clock updates
                    if (window.Clock) {
                        if (!window.Clock.clockInterval) {
                            window.Clock.init();
                        }
                        // Force immediate update to show current time
                        window.Clock.updateClock();
                    }
                }
            } else if (this.currentState === this.STATES.CLOCK || this.currentState === this.STATES.ALARM_TRIGGERED || [this.STATES.ALARM_CLOCK, this.STATES.ALARM_SETTING_HOUR, this.STATES.ALARM_SETTING_MINUTE].includes(this.currentState)) {
                // Fade out clock
                clockDisplay.style.transition = `opacity ${this.config.clockFadeOutDuration}ms ease-out`;
                clockDisplay.style.opacity = '0';
                setTimeout(() => {
                    const isCurrentAlarmState = [this.STATES.ALARM_CLOCK, this.STATES.ALARM_SETTING_HOUR, this.STATES.ALARM_SETTING_MINUTE].includes(this.currentState);
                    if (this.currentState !== this.STATES.CLOCK && this.currentState !== this.STATES.ALARM_TRIGGERED && !isCurrentAlarmState) {
                        clockDisplay.style.display = 'none';
                        clockDisplay.classList.remove('alarm-mode', 'alarm-setting-hour', 'alarm-setting-minute');
                    }
                }, this.config.clockFadeOutDuration);
            }
        }
    },

    // Update the status display
    updateStatus() {
        const statusDiv = document.getElementById('status');
        if (!statusDiv) return;
        let statusText = `${this.currentState.charAt(0).toUpperCase() + this.currentState.slice(1)}`;
        
        if (this.currentState === this.STATES.ERROR && this.error) {
            statusText += ` - ${this.error}`;
        }
        
        statusDiv.textContent = statusText;
    },

    // Play latest video
    playLatestVideo() {
        console.log('Playing latest video');
        // Request the latest video from server
        if (window.socket) {
            window.socket.emit('show_previous_dream');
            this.updateState(this.STATES.PLAYBACK);
        }
    },

    // Play previous video
    playPreviousVideo() {
        console.log('Playing previous video');
        // Request the previous video from server
        if (window.socket) {
            window.socket.emit('show_previous_dream');
            this.updateState(this.STATES.PLAYBACK);
        }
    },

    // Handle recording start
    startRecording() {
        if (this.currentState === this.STATES.RECORDING) {
            console.log(`Already recording`);
            return;
        }

        this.updateState(this.STATES.RECORDING);
        
        if (window.startRecording) {
            window.startRecording();
        }
    },

    // Handle recording stop
    stopRecording() {
        if (this.currentState !== this.STATES.RECORDING) {
            console.log(`Cannot stop recording in ${this.currentState} state`);
            return;
        }

        this.updateState(this.STATES.PROCESSING);
        
        if (window.stopRecording) {
            window.stopRecording();
        }
    },

    // Handle device events based on mode
    async handleDeviceEvent(eventType) {
        console.log(`Handling device event: ${eventType}`);
        
        switch (eventType) {
            case 'alarm_triggered':
                this.updateState(this.STATES.ALARM_TRIGGERED);
                break;
            case 'single_tap':
                if (this.currentState === this.STATES.ALARM_TRIGGERED) {
                    // Dismiss alarm
                    this.updateState(this.STATES.CLOCK);
                    return; // Stop processing further conditions
                } else if (this.currentState === this.STATES.RECORDING) {
                    // Any tap during recording stops it
                    this.stopRecording();
                } else if (this.currentState === this.STATES.PLAYBACK) {
                    // Single tap during playback shows previous video
                    this.playPreviousVideo();
                } else if (this.currentState === this.STATES.CLOCK) {
                    // Single tap in clock state plays most recent video
                    this.playLatestVideo();
                } else if (this.currentState === this.STATES.ALARM_CLOCK || this.currentState === this.STATES.ALARM_SETTING_HOUR) {
                    // Single tap in alarm clock (hour setting) increments hour
                    this.incrementAlarmHour();
                } else if (this.currentState === this.STATES.ALARM_SETTING_MINUTE) {
                    // Single tap in minute setting increments minute
                    this.incrementAlarmMinute();
                } else if (this.currentState === this.STATES.ERROR) {
                    // Hide errorDiv and return to clock
                    if (window.errorDiv) {
                        window.errorDiv.style.display = 'none';
                    }
                    this.updateState(this.STATES.CLOCK);
                }
                break;
                
            case 'double_tap':
                if (this.currentState === this.STATES.CLOCK) {
                    // Double tap in clock state starts recording
                    this.startRecording();
                } else if (this.currentState === this.STATES.ALARM_CLOCK || this.currentState === this.STATES.ALARM_SETTING_HOUR) {
                    // Double tap in alarm clock (hour setting) decrements hour
                    this.decrementAlarmHour();
                } else if (this.currentState === this.STATES.ALARM_SETTING_MINUTE) {
                    // Double tap in minute setting decrements minute
                    this.decrementAlarmMinute();
                } else if (this.currentState === this.STATES.PLAYBACK) {
                    // Double tap during playback returns to clock
                    this.updateState(this.STATES.CLOCK);
                } else if (this.currentState === this.STATES.RECORDING) {
                    // Double tap during recording cancels and returns to clock
                    if (window.stopRecording) {
                        window.stopRecording();
                    }
                    this.updateState(this.STATES.CLOCK);
                }
                break;
                
            case 'hold':
                if (this.currentState === this.STATES.CLOCK) {
                    // Hold in clock state enters alarm clock mode and loads saved settings
                    await this.loadAlarmSettings();
                    this.updateState(this.STATES.ALARM_CLOCK);
                } else if (this.currentState === this.STATES.ALARM_CLOCK) {
                    // Hold in alarm clock (hour setting) goes to minute setting
                    this.updateState(this.STATES.ALARM_SETTING_MINUTE);
                } else if (this.currentState === this.STATES.ALARM_SETTING_HOUR) {
                    // Hold in hour setting goes to minute setting
                    this.updateState(this.STATES.ALARM_SETTING_MINUTE);
                } else if (this.currentState === this.STATES.ALARM_SETTING_MINUTE) {
                    // Hold in minute setting returns to normal clock
                    // Ensure clock shows current time when returning
                    if (window.Clock) {
                        window.Clock.updateClock();
                    }
                    this.updateState(this.STATES.CLOCK);
                }
                break;
                
            case 'triple_tap':
                if (this.currentState === this.STATES.CLOCK) {
                    // Triple tap in clock state toggles alarm on/off
                    try {
                        const response = await fetch('/api/alarm/toggle', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            }
                        });
                        
                        if (response.ok) {
                            const data = await response.json();
                            console.log(`Alarm toggled: ${data.enabled ? 'enabled' : 'disabled'}`);
                            // Update alarm indicator
                            if (window.Clock && typeof window.Clock.updateAlarmIndicator === 'function') {
                                window.Clock.updateAlarmIndicator();
                            }
                        } else {
                            console.error('Failed to toggle alarm');
                        }
                    } catch (error) {
                        console.error('Error toggling alarm:', error);
                    }
                }
                break;
                
            default:
                console.log(`Unhandled event type: ${eventType}`);
        }
    },

    // Register a callback for state changes
    registerStateChangeCallback(callback) {
        this.stateChangeCallbacks.push(callback);
    },

    // Increment alarm hour
    incrementAlarmHour() {
        this.alarmHour = (this.alarmHour + 1) % 24;
        this.updateAlarmDisplay();
        this.saveAlarmSettings(); // Auto-save when changed
    },

    // Decrement alarm hour
    decrementAlarmHour() {
        this.alarmHour = (this.alarmHour - 1 + 24) % 24;
        this.updateAlarmDisplay();
        this.saveAlarmSettings(); // Auto-save when changed
    },

    // Increment alarm minute
    incrementAlarmMinute() {
        this.alarmMinute = (this.alarmMinute + 1) % 60;
        this.updateAlarmDisplay();
        this.saveAlarmSettings(); // Auto-save when changed
    },

    // Decrement alarm minute
    decrementAlarmMinute() {
        this.alarmMinute = (this.alarmMinute - 1 + 60) % 60;
        this.updateAlarmDisplay();
        this.saveAlarmSettings(); // Auto-save when changed
    },

    // Update alarm display
    updateAlarmDisplay() {
        const hourTens = document.querySelector('.hour-tens');
        const hourOnes = document.querySelector('.hour-ones');
        const minuteTens = document.querySelector('.minute-tens');
        const minuteOnes = document.querySelector('.minute-ones');
        const colon = document.querySelector('.colon');

        if (hourTens && hourOnes && minuteTens && minuteOnes) {
            const hourStr = this.alarmHour.toString().padStart(2, '0');
            const minuteStr = this.alarmMinute.toString().padStart(2, '0');

            hourTens.textContent = hourStr[0];
            hourOnes.textContent = hourStr[1];
            minuteTens.textContent = minuteStr[0];
            minuteOnes.textContent = minuteStr[1];
        }
        
        // Ensure colon is visible in alarm modes
        if (colon) {
            colon.classList.remove('hidden');
        }
    },

    // Load alarm settings from server
    async loadAlarmSettings() {
        try {
            const response = await fetch('/api/alarm');
            if (response.ok) {
                const data = await response.json();
                this.alarmHour = data.hour || 0;
                this.alarmMinute = data.minute || 0;
                console.log(`Loaded alarm settings: ${this.alarmHour.toString().padStart(2, '0')}:${this.alarmMinute.toString().padStart(2, '0')}`);
            } else {
                console.warn('Failed to load alarm settings, using defaults');
                this.alarmHour = 0;
                this.alarmMinute = 0;
            }
        } catch (error) {
            console.error('Error loading alarm settings:', error);
            this.alarmHour = 0;
            this.alarmMinute = 0;
        }
    },

    // Save alarm settings to server
    async saveAlarmSettings() {
        try {
            const response = await fetch('/api/alarm', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    hour: this.alarmHour,
                    minute: this.alarmMinute
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                console.log(`Saved alarm settings: ${this.alarmHour.toString().padStart(2, '0')}:${this.alarmMinute.toString().padStart(2, '0')}`);
            } else {
                console.error('Failed to save alarm settings');
            }
        } catch (error) {
            console.error('Error saving alarm settings:', error);
        }
    }
};

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    StateManager.init();
});

// Make StateManager globally accessible
window.StateManager = StateManager; 
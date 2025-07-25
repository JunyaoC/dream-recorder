# =============================
# Imports & Initial Setup
# =============================
from gevent import monkey
monkey.patch_all()

import os
import logging
import gevent
import io
import json
import argparse

# Set timezone from config before any time functions are used
try:
    from functions.config_loader import get_config
    tz = get_config().get("TIMEZONE", "UTC")
    os.environ['TZ'] = tz
    import time
    time.tzset()
except Exception as e:
    print(f"Warning: Could not set timezone from config: {e}")

from flask import Flask, render_template, jsonify, request, send_file
from flask_socketio import SocketIO, emit
from functions.dream_db import DreamDB
from functions.audio import create_wav_file, process_audio
from functions.config_loader import load_config, get_config

# Configure logging
logging.basicConfig(level=getattr(logging, get_config()["LOG_LEVEL"]))
logger = logging.getLogger(__name__)

# =============================
# Global Variables & Constants
# =============================

# Global state for recording
recording_state = {
    'is_recording': False,
    'status': 'ready',  # ready, recording, processing, generating, complete
    'transcription': '',
    'video_prompt': '',
    'video_url': None
}

# Video playback state
video_playback_state = {
    'current_index': 0,  # Index of the current video being played
    'is_playing': False  # Whether a video is currently playing
}

# Audio buffer for storing chunks
audio_buffer = io.BytesIO()
wav_file = None

# List to store incoming audio chunks
audio_chunks = []

# =============================
# Flask App & Extensions Initialization
# =============================

# Initialize Flask app
app = Flask(__name__)
app.config.update(
    DEBUG=os.environ.get("FLASK_ENV", "production") == "development",
    HOST=get_config()["HOST"],
    PORT=int(os.environ.get("PORT", get_config()["PORT"]))
)

# Initialize SocketIO
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

# Initialize DreamDB
dream_db = DreamDB()

# =============================
# Core Logic / Helper Functions
# =============================

def initiate_recording():
    """Handles the common state changes and buffer resets for starting recording."""
    global audio_buffer, wav_file, audio_chunks
    recording_state['is_recording'] = True
    recording_state['status'] = 'recording'
    recording_state['transcription'] = '' # Reset transcription
    recording_state['video_prompt'] = ''  # Reset video prompt
    # Reset audio storage
    audio_buffer = io.BytesIO() 
    audio_chunks = []
    wav_file = None # Ensure wav_file is reset before creating a new one
    wav_file = create_wav_file(audio_buffer)
    if logger:
        logger.debug("Initiated recording: state set, buffers reset, wav file created.")

def init_sample_dreams_if_missing():
    """Attempt to initialize sample dreams by running the init_sample_dreams script."""
    import subprocess
    import sys
    import os
    try:
        script_path = os.path.join(os.path.dirname(__file__), 'scripts', 'init_sample_dreams.py')
        result = subprocess.run([sys.executable, script_path], capture_output=True, text=True)
        if result.returncode == 0:
            print("Sample dreams initialized.")
        else:
            print("Failed to initialize sample dreams.")
    except Exception as e:
        print(f"Exception while initializing sample dreams: {e}")

# =============================
# SocketIO Event Handlers
# =============================

@socketio.on('connect')
def handle_connect(auth=None):
    """Handle new client connection."""
    if logger:
        logger.info('Client connected')
    emit('state_update', recording_state)

@socketio.on('disconnect')
def handle_disconnect():
    """Handle client disconnection."""
    if logger:
        logger.info('Client disconnected')

@socketio.on('start_recording')
def handle_start_recording():
    """Socket event to start recording."""
    if not recording_state['is_recording']:
        initiate_recording()
        emit('state_update', recording_state)
        if logger:
            logger.info('Started recording via socket event')
    else:
        if logger:
            logger.warning('Start recording event received, but already recording.')

@socketio.on('stream_recording')
def handle_audio_data(data):
    """Handle incoming audio data chunks from the client during recording."""
    if recording_state['is_recording']:
        try:
            # Convert the received data to bytes
            audio_bytes = bytes(data['data'])
            # Store the chunk
            audio_chunks.append(audio_bytes)
        except Exception as e:
            if logger:
                logger.error(f"Error handling audio data: {str(e)}")
            emit('error', {'message': f"Error handling audio data: {str(e)}"})

@socketio.on('stop_recording')
def handle_stop_recording():
    """Socket event to stop recording and trigger processing."""
    if recording_state['is_recording']:
        sid = request.sid # Get SID before changing state

        # Finalize the recording
        recording_state['is_recording'] = False
        recording_state['status'] = 'processing'
        if logger:
            logger.info(f"Finalizing recording. Status set to processing. Triggering process_audio for SID: {sid}")

        # Process the audio in a background task, passing all required arguments
        gevent.spawn(
            process_audio, sid, socketio, dream_db, recording_state, audio_chunks, logger
        )

        # Emit the comprehensive state update after finalizing
        emit('state_update', recording_state)
        if logger:
            logger.info('Stopped recording via socket event.')
    else:
        if logger:
            logger.warning('Stop recording event received, but not currently recording.')

@socketio.on('show_previous_dream')
def handle_show_previous_dream():
    """Socket event handler for showing previous dream."""
    try:
        # Get the most recent dreams
        dreams = dream_db.get_all_dreams()
        if not dreams:
            if logger:
                logger.warning("No dreams found to cycle through.")
            return None
        # If we're currently playing a video, show the next one in sequence
        if video_playback_state['is_playing']:
            video_playback_state['current_index'] += 1
            if video_playback_state['current_index'] >= len(dreams):
                video_playback_state['current_index'] = 0  # Wrap around
        else:
            # If not playing, start with the most recent dream
            video_playback_state['current_index'] = 0
            video_playback_state['is_playing'] = True
        # Get the dream at the current index
        dream = dreams[video_playback_state['current_index']]
        # Emit the video URL to the client
        socketio.emit('play_video', {
            'video_url': f"/media/video/{dream['video_filename']}",
            'loop': True  # Enable looping for the video
        })
        if logger:
            logger.info(f"Emitted play_video for dream index {video_playback_state['current_index']}: {dream['video_filename']}")

        if not dream:
            socketio.emit('error', {'message': 'No dreams found'})
    except Exception as e:
        if logger:
            logger.error(f"Error in socket handle_show_previous_dream: {str(e)}")
        socketio.emit('error', {'message': str(e)})

# =============================
# Flask Route Handlers
# =============================

# -- Page Routes --
@app.route('/')
def index():
    """Serve the main HTML page."""
    return render_template('index.html', 
                         is_development=app.config['DEBUG'],
                         total_background_images=int(get_config()["TOTAL_BACKGROUND_IMAGES"]))

@app.route('/dreams')
def dreams():
    """Display the dreams library page."""
    dreams = dream_db.get_all_dreams()
    return render_template('dreams.html', dreams=dreams)

# -- API Routes --
@app.route('/api/config')
def api_get_config():
    try:
        from functions.config_loader import get_config
        config = get_config()
        return jsonify({
            'is_development': app.config['DEBUG'],
            'playback_duration': int(config['PLAYBACK_DURATION']),
            'logo_fade_in_duration': int(config['LOGO_FADE_IN_DURATION']),
            'logo_fade_out_duration': int(config['LOGO_FADE_OUT_DURATION']),
            'clock_fade_in_duration': int(config['CLOCK_FADE_IN_DURATION']),
            'clock_fade_out_duration': int(config['CLOCK_FADE_OUT_DURATION']),
            'transition_delay': int(config['TRANSITION_DELAY'])
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/gpio_single_tap', methods=['POST'])
def gpio_single_tap():
    """API endpoint for single tap from GPIO controller."""
    try:
        # Notify all clients of a single tap event
        socketio.emit('device_event', {'eventType': 'single_tap'})
        return jsonify({'status': 'success'})
    except Exception as e:
        if logger:
            logger.error(f"Error in API gpio_single_tap: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/gpio_double_tap', methods=['POST'])
def gpio_double_tap():
    """API endpoint for double tap from GPIO controller."""
    try:
        # Notify all clients of a double tap event
        socketio.emit('device_event', {'eventType': 'double_tap'})
        return jsonify({'status': 'success'})
    except Exception as e:
        if logger:
            logger.error(f"Error in API gpio_double_tap: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/gpio_triple_tap', methods=['POST'])
def gpio_triple_tap():
    """API endpoint for triple tap from GPIO controller."""
    try:
        # Notify all clients of a triple tap event
        socketio.emit('device_event', {'eventType': 'triple_tap'})
        return jsonify({'status': 'success'})
    except Exception as e:
        if logger:
            logger.error(f"Error in API gpio_triple_tap: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/gpio_hold', methods=['POST'])
def gpio_hold():
    """API endpoint for hold from GPIO controller."""
    try:
        # Notify all clients of a hold event
        socketio.emit('device_event', {'eventType': 'hold'})
        return jsonify({'status': 'success'})
    except Exception as e:
        if logger:
            logger.error(f"Error in API gpio_hold: {str(e)}")
        return jsonify({'status': 'error', 'message': str(e)}), 500

@app.route('/api/dreams/<int:dream_id>', methods=['DELETE'])
def delete_dream(dream_id):
    """Delete a dream and its associated files."""
    try:
        # Get the dream details before deletion
        dream = dream_db.get_dream(dream_id)
        if not dream:
            return jsonify({'success': False, 'message': 'Dream not found'}), 404
        # Delete the dream from the database
        if dream_db.delete_dream(dream_id):
            # Delete associated files
            try:
                # Delete video file
                video_path = os.path.join(get_config()['VIDEOS_DIR'], dream['video_filename'])
                if os.path.exists(video_path):
                    os.remove(video_path)
                # Delete thumbnail file
                thumb_path = os.path.join(get_config()['THUMBS_DIR'], dream['thumb_filename'])
                if os.path.exists(thumb_path):
                    os.remove(thumb_path)
                # Delete audio file
                audio_path = os.path.join(get_config()['RECORDINGS_DIR'], dream['audio_filename'])
                if os.path.exists(audio_path):
                    os.remove(audio_path)
            except Exception as e:
                if logger:
                    logger.error(f"Error deleting files for dream {dream_id}: {str(e)}")
                # Continue even if file deletion fails
            return jsonify({'success': True, 'message': 'Dream deleted successfully'})
        else:
            return jsonify({'success': False, 'message': 'Failed to delete dream'}), 500
    except Exception as e:
        if logger:
            logger.error(f"Error deleting dream {dream_id}: {str(e)}")
        return jsonify({'success': False, 'message': str(e)}), 500

@app.route('/api/clock-config-path')
def clock_config_path():
    from functions.config_loader import get_config
    config_path = get_config().get('CLOCK_CONFIG_PATH')
    if not config_path:
        return jsonify({'error': 'CLOCK_CONFIG_PATH not set in config'}), 500
    return jsonify({'configPath': config_path})

@app.route('/api/notify_config_reload', methods=['POST'])
def notify_config_reload():
    """Notify all clients to reload config."""
    load_config()
    socketio.emit('reload_config')
    return jsonify({'status': 'reload event emitted'})

@app.route('/api/alarm', methods=['GET'])
def get_alarm():
    """Get the current alarm settings."""
    try:
        alarm_file = 'alarm.json'
        if os.path.exists(alarm_file):
            with open(alarm_file, 'r') as f:
                alarm_data = json.load(f)
            # Ensure 'enabled' field exists for backward compatibility
            if 'enabled' not in alarm_data:
                alarm_data['enabled'] = True
        else:
            # Default values if file doesn't exist
            alarm_data = {'hour': 0, 'minute': 0, 'enabled': True}
        return jsonify(alarm_data)
    except Exception as e:
        if logger:
            logger.error(f"Error reading alarm settings: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/alarm', methods=['POST'])
def save_alarm():
    """Save alarm settings to file."""
    try:
        data = request.get_json()
        if not data or 'hour' not in data or 'minute' not in data:
            return jsonify({'error': 'Missing hour or minute in request'}), 400
        
        # Validate values
        hour = int(data['hour'])
        minute = int(data['minute'])
        if not (0 <= hour <= 23) or not (0 <= minute <= 59):
            return jsonify({'error': 'Invalid hour or minute values'}), 400
        
        # Get existing alarm data to preserve enabled state if not provided
        alarm_file = 'alarm.json'
        existing_enabled = True  # Default
        if os.path.exists(alarm_file):
            try:
                with open(alarm_file, 'r') as f:
                    existing_data = json.load(f)
                    existing_enabled = existing_data.get('enabled', True)
            except:
                pass
        
        # Use provided enabled value or existing one
        enabled = data.get('enabled', existing_enabled)
        
        alarm_data = {'hour': hour, 'minute': minute, 'enabled': enabled}
        
        # Save to file
        with open(alarm_file, 'w') as f:
            json.dump(alarm_data, f, indent=2)
        
        if logger:
            logger.info(f"Alarm settings saved: {hour:02d}:{minute:02d} (enabled: {enabled})")
        
        return jsonify({'status': 'success', 'data': alarm_data})
    except Exception as e:
        if logger:
            logger.error(f"Error saving alarm settings: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/alarm/toggle', methods=['POST'])
def toggle_alarm():
    """Toggle the alarm enabled status."""
    try:
        alarm_file = 'alarm.json'
        
        # Load existing alarm data
        if os.path.exists(alarm_file):
            with open(alarm_file, 'r') as f:
                alarm_data = json.load(f)
        else:
            # Default values if file doesn't exist
            alarm_data = {'hour': 0, 'minute': 0, 'enabled': True}
        
        # Toggle enabled status
        alarm_data['enabled'] = not alarm_data.get('enabled', True)
        
        # Save to file
        with open(alarm_file, 'w') as f:
            json.dump(alarm_data, f, indent=2)
        
        if logger:
            logger.info(f"Alarm toggled to: {'enabled' if alarm_data['enabled'] else 'disabled'}")
        
        # Notify all clients to update their alarm indicator
        socketio.emit('alarm_toggled', {'enabled': alarm_data['enabled']})
        
        return jsonify({'status': 'success', 'enabled': alarm_data['enabled']})
    except Exception as e:
        if logger:
            logger.error(f"Error toggling alarm: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/check_alarm', methods=['POST'])
def check_alarm():
    """Check the current time against alarm.json and trigger alarm if matched."""
    try:
        import time
        alarm_file = 'alarm.json'
        if os.path.exists(alarm_file):
            with open(alarm_file, 'r') as f:
                alarm_data = json.load(f)
        else:
            return jsonify({'status': 'no_alarm_set'}), 200

        # Check if alarm is enabled
        if not alarm_data.get('enabled', True):
            return jsonify({'status': 'alarm_disabled'}), 200

        # Get current local time
        now = time.localtime()
        current_hour = now.tm_hour
        current_minute = now.tm_min
        if logger:
            logger.info(f"[check_alarm] now={now}, current_hour={current_hour}, current_minute={current_minute}")

        # Compare with alarm
        alarm_hour = int(alarm_data.get('hour', -1))
        alarm_minute = int(alarm_data.get('minute', -1))

        if current_hour == alarm_hour and current_minute == alarm_minute:
            socketio.emit('device_event', {'eventType': 'alarm_triggered'})
            if logger:
                logger.info(f"Alarm triggered at {current_hour:02d}:{current_minute:02d} via /check_alarm endpoint.")
            return jsonify({'status': 'alarm triggered'})
        else:
            return jsonify({'status': 'no match', 'current_time': f'{current_hour:02d}:{current_minute:02d}', 'alarm_time': f'{alarm_hour:02d}:{alarm_minute:02d}'})
    except Exception as e:
        if logger:
            logger.error(f"Error checking alarm: {str(e)}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/audio_devices')
def list_audio_devices():
    """List available audio devices for debugging."""
    try:
        import sounddevice as sd
        devices = sd.query_devices()
        device_list = []
        
        for i, device in enumerate(devices):
            device_info = {
                'index': i,
                'name': device['name'],
                'channels': device['max_output_channels'],
                'is_default': i == sd.default.device[1]
            }
            device_list.append(device_info)
        
        return jsonify({
            'devices': device_list,
            'default_output': sd.default.device[1]
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# -- Media Routes --
@app.route('/media/<path:filename>')
def serve_media(filename):
    """Serve media files (audio and video) from the media directory."""
    try:
        return send_file(os.path.join('media', filename))
    except FileNotFoundError:
        return "File not found", 404

@app.route('/media/thumbs/<path:filename>')
def serve_thumbnail(filename):
    """Serve thumbnail files from the thumbs directory."""
    try:
        return send_file(os.path.join(get_config()['THUMBS_DIR'], filename))
    except FileNotFoundError:
        return "Thumbnail not found", 404

# =============================
# Main Execution Block
# =============================

if __name__ == '__main__':  # pragma: no cover
    # Parse command-line arguments
    parser = argparse.ArgumentParser()
    parser.add_argument('--reload', action='store_true', help='Enable auto-reloader')
    args = parser.parse_args()
    # Start the Flask-SocketIO server
    socketio.run(
        app, 
        host=app.config['HOST'], 
        port=app.config['PORT'], 
        debug=app.config['DEBUG'],
        use_reloader=args.reload
    ) 
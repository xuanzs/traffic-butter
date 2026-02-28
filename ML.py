import cv2
import time
import csv
from datetime import datetime
from ultralytics import YOLO

# Load Medium Model
model = YOLO('yolov8m.pt')

video_path = "traffic_video.mp4"
cap = cv2.VideoCapture(video_path)

# --- CONFIGURATION ---
line_y = 500       
offset = 15         
moto_offset = 25    
min_travel = 15     
moto_travel = 8     
skip_frames = 2     

# --- COUNTERS ---
counts = {'car': 0, 'motorcycle': 0, 'bus': 0, 'truck': 0}
interval_counts = {'car': 0, 'motorcycle': 0, 'bus': 0, 'truck': 0}
track_history = {} 
class_map = {2: 'car', 3: 'motorcycle', 5: 'bus', 7: 'truck'}
frame_count = 0

# --- CSV SETUP ---
csv_filename = "traffic_flow_data.csv"
# Create the file and write the header row
with open(csv_filename, mode='w', newline='') as file:
    writer = csv.writer(file)
    writer.writerow(["Timestamp", "Cars_Flow", "Motorcycles_Flow", "Trucks_Flow", "Buses_Flow", "Total_Interval_Flow", "Cumulative_Flow", "Vehicles_In_Frame_(Queue_Proxy)"])

# --- TIMER SETUP ---
last_summary_time = time.time()  
summary_interval = 30            

print(f"--- Traffic Monitor Started. Logging to {csv_filename} every {summary_interval}s ---")

while cap.isOpened():
    success, frame = cap.read()
    if not success:
        break

    frame_count += 1
    if frame_count % skip_frames != 0:
        continue 

    frame = cv2.resize(frame, (1020, 600))
    height, width, _ = frame.shape

    cv2.line(frame, (0, line_y), (width, line_y), (255, 0, 0), 2)

    results = model.track(frame, persist=True, conf=0.25, iou=0.5, classes=[2, 3, 5, 7], verbose=False)
    
    # Track how many vehicles are currently in this exact frame (Queue Proxy)
    current_vehicles_in_frame = 0

    if results[0].boxes.id is not None:
        boxes = results[0].boxes.xyxy.cpu().numpy()
        track_ids = results[0].boxes.id.cpu().numpy().astype(int)
        class_ids = results[0].boxes.cls.cpu().numpy().astype(int)
        
        current_vehicles_in_frame = len(track_ids) # Count total detections in current frame
        
        for box, track_id, class_id in zip(boxes, track_ids, class_ids):
            x1, y1, x2, y2 = box
            front_x = int((x1 + x2) / 2)
            front_y = int(y2)
            
            vehicle_type = class_map[class_id]
            
            current_offset = moto_offset if vehicle_type == 'motorcycle' else offset
            current_min_travel = moto_travel if vehicle_type == 'motorcycle' else min_travel

            if track_id not in track_history:
                track_history[track_id] = {'start_y': front_y, 'curr_y': front_y, 'counted': False}
            else:
                track_history[track_id]['curr_y'] = front_y

            distance_moved = track_history[track_id]['curr_y'] - track_history[track_id]['start_y']

            if (line_y - current_offset) < front_y < (line_y + current_offset):
                if not track_history[track_id]['counted']:
                    if distance_moved > current_min_travel: 
                        counts[vehicle_type] += 1
                        interval_counts[vehicle_type] += 1  
                        track_history[track_id]['counted'] = True
                        
                        flash_color = (0, 165, 255) if vehicle_type == 'motorcycle' else (0, 255, 0)
                        cv2.line(frame, (0, line_y), (width, line_y), flash_color, 4)

            # Visuals
            color = (0, 165, 255) if vehicle_type == 'motorcycle' else (0, 255, 0)
            cv2.rectangle(frame, (int(x1), int(y1)), (int(x2), int(y2)), color, 2)
            cv2.circle(frame, (front_x, front_y), 5, color, -1) 

    # --- TIME CHECK, CSV WRITING & CONSOLE OUTPUT ---
    current_time = time.time()
    if current_time - last_summary_time >= summary_interval:
        
        interval_total = sum(interval_counts.values())
        cumulative_total = sum(counts.values())
        
        # 1. Get readable timestamp
        timestamp_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # 2. Write Data to CSV
        with open(csv_filename, mode='a', newline='') as file:
            writer = csv.writer(file)
            writer.writerow([
                timestamp_str, 
                interval_counts['car'], 
                interval_counts['motorcycle'], 
                interval_counts['truck'], 
                interval_counts['bus'], 
                interval_total, 
                cumulative_total,
                current_vehicles_in_frame
            ])
        
        # 3. Console Report
        print(f"\n[{timestamp_str}] Logged to CSV:")
        print(f" Flow: {interval_total} vehicles | Queue Proxy: {current_vehicles_in_frame} vehicles in frame")

        # 4. RESET Interval Counts
        interval_counts = {'car': 0, 'motorcycle': 0, 'bus': 0, 'truck': 0}
        last_summary_time = current_time

    # --- SCREEN STATS (Cumulative) ---
    total_vehicles = sum(counts.values())
    cv2.putText(frame, f"TOTAL: {total_vehicles}", (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 255, 255), 3)

    cv2.imshow("GreenPulse AI Tracker", frame)
    if cv2.waitKey(1) & 0xFF == ord("q"):
        break

cap.release()
cv2.destroyAllWindows()
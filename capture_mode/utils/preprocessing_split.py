import os
import pandas as pd
import numpy as np
from sklearn.preprocessing import LabelEncoder, OneHotEncoder
from tqdm import tqdm
import json

### DEFINE PREPROCESSING FUNCTION ###
def hand_normalize(hand_data):
    '''
        Normalize hand landmarks to a bounding box of x,y = [-0.5, 0.5], centered at (0,0)
        Arguments: hand landmarks, input shape of (21,2)
    '''
    xmin=np.min(hand_data[:,0])
    xmax=np.max(hand_data[:,0])
    ymin=np.min(hand_data[:,1])
    ymax=np.max(hand_data[:,1])
    
    width=xmax-xmin
    height=ymax-ymin
    
    #shift to (0,0)
    center = np.array([(xmin+xmax)/2,(ymin+ymax)/2])
    if width != 0:
        hand_data[:,0] = (hand_data[:,0]-center[0])/width
    else:
        hand_data[:,0] = 0
        
    if height != 0:
        hand_data[:,1] = (hand_data[:,1]-center[1])/height
    else:
        hand_data[:,1] = 0
    
    return hand_data

def distance(x1,x2): 
    '''
    Calculate the distance between two landmarks
    '''
    delta = x1-x2
    d = (delta[0]**2+delta[1]**2)**0.5
    return d

def AnchorNorm(target,scale,reference):
    '''
    Anchor normalization, move landmarks to a reference point and scale based on distance of two landmarks.
    '''
    normalized = (target-reference)/(scale+0.01)
    return normalized


def pad_video(X):
    padded_length = 150
    data_array=np.zeros((padded_length,X.shape[1],X.shape[2]))
    for landmark in range(0,X.shape[1]):
        for coordinate in range(0,X.shape[2]):
            data_array[:,landmark,coordinate] = np.tile(X[:,landmark,coordinate],int(padded_length/X.shape[0]+2))[:padded_length]
    return data_array


# === 1. Generate Label Encoder, OneHot Encoder, and Gloss Dictionary ===
def generate_gloss_dictionary(csv_path, save_dict_path='gloss_to_index.json'):
    '''
    Read a single csv file, then generate label encoder (gloss to unique index), onehot_encoder (index to a vector), and gloss_to_index dictionary.
    '''
    df = pd.read_csv(csv_path)
    all_glosses = df['Gloss'].tolist()

    label_encoder = LabelEncoder()
    label_encoder.fit(all_glosses)
    gloss_to_index = {label: idx for idx, label in enumerate(label_encoder.classes_)}

    onehot_encoder = OneHotEncoder()
    integer_encoded = label_encoder.transform(all_glosses).reshape(-1, 1)
    onehot_encoder.fit(integer_encoded)

    with open(save_dict_path, 'w') as f:
        json.dump(gloss_to_index, f)

    return label_encoder, onehot_encoder, gloss_to_index

# 2. Encode Labels 
def encode_labels(label_encoder, onehot_encoder, npz_main_dir, save_dir):
    '''
    Get labels from npz array directory. Outputs one hot encoded y_train, y_val, and y_test in sequence.
    Arguments:
    label_encoder,
    onehot_encoder, 
    npz_main_dir director (the parent folder of train, test, and validation npz arrays), 
    and save_dir (save location of y_train, y_val, and y_test)
    '''
    splits = ['train', 'val', 'test']
    split_y = {}
    for split in splits:
        y_list = []
        split_dir = os.path.join(npz_main_dir, split)
        file_list = sorted(os.listdir(split_dir))
        for filename in tqdm(file_list, desc=f'Encoding labels for {split}'):
            data = np.load(os.path.join(split_dir, filename))
            gloss = data['gloss'].item() if isinstance(data['gloss'], np.ndarray) else data['gloss']
            idx = label_encoder.transform([gloss])[0]
            onehot = onehot_encoder.transform([[idx]])[0]
            y_list.append(onehot)
        split_y[f'y_{split}'] = np.array([x.toarray().squeeze() for x in y_list])
    os.makedirs(save_dir, exist_ok=True)
    np.save(os.path.join(save_dir, 'y_train.npy'), split_y['y_train'])
    np.save(os.path.join(save_dir, 'y_val.npy'), split_y['y_val'])
    np.save(os.path.join(save_dir, 'y_test.npy'), split_y['y_test'])
    return split_y['y_train'], split_y['y_val'], split_y['y_test']


# 3.. Preprocess and Save X 
def preprocess_and_save_x(npz_main_dir, save_dir, split='val'):
    '''
    preprocess mediapipe landmarks. Outputs an array with a size of (number of videos split, 150 frames, 86 landmarks, 2)
    Arguments:
    npz_main_dir directory of parent npz folder that contains split, val, and test folders,
    save_dir save location for x_train, x_test, and x_val,
    split select split to be processed.
    '''
    split_dir = os.path.join(npz_main_dir, split)
    file_list = sorted(os.listdir(split_dir))
    processed_videos = []

    indices_to_remove1 = np.arange(23, 33)
    indices_to_remove2 = np.arange(0, 11)

    for filename in tqdm(file_list, desc=f'Preprocessing {split} set'):
        data = np.load(os.path.join(split_dir, filename))
        landmarks = data['landmarks']

        array_filtered = np.delete(landmarks, indices_to_remove1, axis=1)
        array_filtered = np.delete(array_filtered, indices_to_remove2, axis=1)

        padded = pad_video(array_filtered)
        X = padded.astype(np.float32)

        for frame in range(X.shape[0]):
            neck = abs(X[frame, 0] + X[frame, 1]) / 2
            X[frame, :] = AnchorNorm(X[frame, :], distance(X[frame, 0], X[frame, 1]), neck)
            X[frame, 54:] = AnchorNorm(X[frame, 54:], distance(X[frame, 0], X[frame, 1]), X[frame, 79])

            left_arm = [2, 4, 6, 8, 10]
            right_arm = [3, 5, 7, 9, 11]
            X[frame, left_arm] = AnchorNorm(X[frame, left_arm], distance(X[frame, 0], X[frame, 2]), X[frame, 0])
            X[frame, right_arm] = AnchorNorm(X[frame, right_arm], distance(X[frame, 1], X[frame, 3]), X[frame, 1])

            X[frame, 12:33] = hand_normalize(X[frame, 12:33])
            X[frame, 33:54] = hand_normalize(X[frame, 33:54])

        processed_videos.append(X)

    os.makedirs(save_dir, exist_ok=True)
    np.save(os.path.join(save_dir, f'x_{split}.npy'), np.array(processed_videos))

    return np.array(processed_videos)

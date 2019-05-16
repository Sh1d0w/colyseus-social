import mongoose from "mongoose";
import User, { IUser, Platform } from "./models/User";
import { getFacebookUser } from "./facebook";

import { MONGO_URI } from "./env";
import { MongoError } from "mongodb";
import FriendRequest, { IFriendRequest } from "./models/FriendRequest";

const debug = require('debug')('@colyseus/social');
const DEFAULT_USER_FIELDS: Array<keyof IUser> = ['_id', 'username', 'displayName', 'avatarUrl', 'metadata'];
const ONLINE_SECONDS = 40;

export type ObjectId = string | mongoose.Schema.Types.ObjectId;

export async function connectDatabase(cb?: (err: MongoError) => void) {
    // skip if already connecting or connected.
    if (mongoose.connection.readyState !== 0) {
        if (cb) cb(null);
        return;
    }

    try {
        await mongoose.connect(MONGO_URI, { autoIndex: false, useNewUrlParser: true }, cb);
        debug(`Successfully connected to ${MONGO_URI}`)

        // reconnect if disconnected.
        mongoose.connection.on('disconnected', () => connectDatabase());
    } catch (e) {
        console.error('Error connecting to database: ', e);
    }
}

export async function pingUser(userId: ObjectId) {
    await User.updateOne({ _id: userId }, { $set: { updatedAt: Date.now() } });
}

export async function facebookAuth(accessToken: string): Promise<IUser> {
    const data = await getFacebookUser(accessToken);
    const facebookId = data.id;

    // fetch existing users by their facebookId from database
    const facebookFriendsIds = data.friends.data.map(friend => friend.id);
    const friendIds = (facebookFriendsIds.length === 0)
        ? []
        : (await User.
            find({ facebookId: { $in: facebookFriendsIds } }, ["_id"])).
            map(user => user._id);

    // find or create user
    await User.updateOne({ facebookId }, {
        $setOnInsert: {
            username: data.name,
            displayName: data.short_name,
            email: data.email,
        },
        $set: {
            avatarUrl: data.picture.data.url,
            online: true,
        },
        $addToSet: {
            friendIds: friendIds
        }
    }, { upsert: true });

    const currentUser = await User.findOne({ facebookId });

    // Add current user to existing users friend list.
    await Promise.all(facebookFriendsIds.map((facebookId) => {
        return User.updateOne({ facebookId }, {
            $addToSet: { friendIds: currentUser._id }
        });
    }));

    return currentUser;
}

export async function assignDeviceToUser (user: IUser, deviceId: string, platform: Platform) {
    const existingDevice = user.devices.filter(device =>
        device.id === deviceId && device.platform === platform)[0]

    if (!existingDevice) {
        user.devices.push({ id: deviceId, platform: platform });
        await user.save();
    }
}

export async function sendFriendRequest(senderId: ObjectId, receiverId: ObjectId) {
    const isAllowedToSend = await User.findOne({
        _id: receiverId,
        blockedUserIds: { $nin: [senderId] }
    });

    if (isAllowedToSend !== null) {
        return await FriendRequest.updateOne({
            sender: senderId,
            receiver: receiverId
        }, {}, {
            upsert: true
        });

    } else {
        return false;
    }
}

export async function consumeFriendRequest(receiverId: ObjectId, senderId: ObjectId, accept: boolean = true) {
    if (accept) {
        await User.updateOne({ _id: receiverId }, { $addToSet: { friendIds: senderId } });
        await User.updateOne({ _id: senderId }, { $addToSet: { friendIds: receiverId } });
    }
    await FriendRequest.remove({ sender: senderId, receiver: receiverId });
}

export async function blockUser(userId: ObjectId, blockedUserId: ObjectId) {
    await User.updateOne({ _id: userId }, {
        $addToSet: { blockedUserIds: blockedUserId },
        $pull: { friendIds: blockedUserId }
    });
    await User.updateOne({ _id: blockedUserId }, {
        $pull: { friendIds: userId }
    });
    await FriendRequest.deleteOne({ sender: blockedUserId, receiver: userId });
}

export async function unblockUser(userId: ObjectId, blockedUserId: ObjectId) {
    await User.updateOne({ _id: userId }, {
        $addToSet: { friendIds: blockedUserId },
        $pull: { blockedUserIds: blockedUserId }
    });
}

export async function getFriendRequests(userId: ObjectId): Promise<IFriendRequest[]> {
    return await FriendRequest.find({ receiver: userId });
}

export async function getFriendRequestsProfile(
    friendRequests: IFriendRequest[],
    fields: Array<keyof IUser> = DEFAULT_USER_FIELDS,
) {
    return await User.find({ _id: { $in: friendRequests.map(request => request.sender) } }, fields);
}

export async function getFriends(
    user: IUser,
    fields: Array<keyof IUser> = DEFAULT_USER_FIELDS,
) {
    return await User.find({ _id: { $in: user.friendIds } }, fields);
}

export async function getOnlineFriends(
    user: IUser,
    fields: Array<keyof IUser> = DEFAULT_USER_FIELDS,
) {
    return await User.find({
        _id: { $in: user.friendIds },
        updatedAt: { $gt: Date.now() - 1000 * ONLINE_SECONDS }
    }, fields);
}

// export async function logout(userId: string | mongoose.Schema.Types.ObjectId) {
//     return await User.updateOne({ _id: userId }, { $set: { online: false } });
// }
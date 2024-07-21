"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Game = void 0;
const crypto_1 = __importDefault(require("crypto"));
const constants_1 = require("../utils/constants");
const misc_1 = require("../utils/misc");
const data_1 = require("../utils/data");
const survivBitStream_1 = require("../utils/survivBitStream");
const math_1 = require("../utils/math");
const map_1 = require("./map");
const player_1 = require("./objects/player");
const aliveCountsPacket_1 = require("../packets/sending/aliveCountsPacket");
const updatePacket_1 = require("../packets/sending/updatePacket");
const joinedPacket_1 = require("../packets/sending/joinedPacket");
const mapPacket_1 = require("../packets/sending/mapPacket");
const planck_1 = require("planck");
const roleAnnouncementPacket_1 = require("../packets/sending/roleAnnouncementPacket");
const loot_1 = require("./objects/loot");
const bullet_1 = require("./bullet");
const explosion_1 = require("./explosion");
const building_1 = require("./objects/building");
class Game {
    id; // The game ID. 16 hex characters, same as MD5
    map;
    gamemode;
    // Used when calculating visible objects
    has8x = false;
    has15x = false;
    world; // The Planck.js World
    staticObjects = new Set(); // A Set of all the static objects in the world
    dynamicObjects = new Set(); // A Set of all the dynamic (moving) objects in the world
    _nextObjectId = -1;
    _nextGroupId = -1;
    visibleObjects = {};
    updateObjects = false;
    partialDirtyObjects = new Set();
    fullDirtyObjects = new Set();
    deletedObjects = new Set();
    loot = new Set();
    stairs = new Set();
    players = new Set(); // All players, including dead and disconnected players.
    connectedPlayers = new Set(); // All connected players. May be dead.
    livingPlayers = new Set(); // All connected and living players.
    spectatablePlayers = []; // Same as activePlayers, but an array. Used to navigate through players when spectating.
    newPlayers = new Set();
    deletedPlayers = new Set();
    playerInfosDirty = false;
    killLeader = { id: 0, kills: 0 };
    killLeaderDirty = false;
    aliveCountDirty = false; // Whether the alive count needs to be updated
    emotes = new Set(); // All emotes sent this tick
    explosions = new Set(); // All explosions created this tick
    bullets = new Set(); // All bullets that currently exist
    newBullets = new Set(); // All bullets created this tick
    aliveCounts;
    kills = new Set(); // All kills this tick
    roleAnnouncements = new Set(); // All role announcements this tick
    damageRecords = new Set(); // All records of damage by bullets this tick
    projectiles = new Set(); // All projectiles that currently exist
    // Red zone, starting values are ignored and replaced
    gas = {
        stage: 0,
        /** 0 = inactive, 1 = waiting, 2 = moving */
        mode: 0,
        initialDuration: 0,
        countdownStart: 0,
        duration: 0,
        posOld: (0, planck_1.Vec2)(0, 0),
        posNew: (0, planck_1.Vec2)(0, 0),
        radOld: 0,
        radNew: 0,
        currentPos: (0, planck_1.Vec2)(0, 0),
        currentRad: 0,
        damage: 0
    };
    gasDirty = false;
    gasCircleDirty = false;
    ticksSinceLastGasDamage = 0;
    over = false; // Whether this game is over. This is set to true to stop the tick loop.
    started = false; // Whether there are more than 2 players, meaning the game has started.
    lobbyStartTime; // time when a second player joins and the timer countdown starts, measured with Date.now()
    timePeriodToAllowJoin; // After this time period has elapsed, players can no longer join the game.
    /**
     * Whether new players should be able to join
     * can also be an indication for the "BattleRoyale" gamemode whether or not the game as officially started
     */
    allowJoin = true;
    spawnWithGoodies = false; // In late game, players spawn with ammo and healing items
    constructor(gamemode) {
        this.gamemode = gamemode;
        this.id = crypto_1.default.createHash("md5").update(crypto_1.default.randomBytes(512)).digest("hex");
        if (this.gamemode == constants_1.GameMode.DeathMatch) {
            this.timePeriodToAllowJoin = (0, math_1.convertToMilliseconds)(5, 30);
        }
        else if (this.gamemode == constants_1.GameMode.BattleRoyale) {
            this.timePeriodToAllowJoin = (0, math_1.convertToMilliseconds)(5, 30);
        }
        // Create the Planck.js World
        this.world = new planck_1.World({
            gravity: (0, planck_1.Vec2)(0, 0)
        });
        planck_1.Settings.maxTranslation = 5.0; // Allows bullets to travel fast
        // Handle bullet collisions
        this.world.on("begin-contact", contact => {
            // planck.js' typings don't allow us to type getUserData in a generic manner, so this
            // will have to do
            const objectA = contact.getFixtureA().getUserData();
            const objectB = contact.getFixtureB().getUserData();
            if (objectA instanceof bullet_1.Bullet && objectA.distance <= objectA.maxDistance && !objectA.dead) {
                objectA.dead = true;
                this.damageRecords.add(new misc_1.DamageRecord(objectB, objectA.shooter, objectA));
            }
            else if (objectB instanceof bullet_1.Bullet && objectB.distance <= objectB.maxDistance && !objectB.dead) {
                objectB.dead = true;
                this.damageRecords.add(new misc_1.DamageRecord(objectA, objectB.shooter, objectB));
            }
            // console.log(objectA.typeString, objectB.typeString);
        });
        // If maxLinearCorrection is set to 0, player collisions work perfectly, but loot doesn't spread out.
        // If maxLinearCorrection is greater than 0, loot spreads out, but player collisions are jittery.
        // This code solves the dilemma by setting maxLinearCorrection to the appropriate value for the object.
        this.world.on("pre-solve", contact => {
            // @ts-expect-error getUserData() should always be a GameObject
            if (contact.getFixtureA().getUserData().isLoot || contact.getFixtureB().getUserData().isLoot)
                planck_1.Settings.maxLinearCorrection = 0.055;
            else
                planck_1.Settings.maxLinearCorrection = 0;
        });
        // Collision filtering code:
        // - Players should collide with obstacles, but not with each other or with loot.
        // - Bullets should collide with players and obstacles, but not with each other or with loot.
        // - Loot should only collide with obstacles and other loot.
        planck_1.Fixture.prototype.shouldCollide = function (that) {
            // Get the objects
            const thisObject = this.getUserData();
            const thatObject = that.getUserData();
            // const display = thatObject.typeString == "" ? (thatObject as Player).name : thatObject.typeString;
            // Make sure the objects are on the same layer
            if (!(0, math_1.sameLayer)(thisObject.layer, thatObject.layer))
                return false;
            // if (thisObject instanceof Bullet){
            //     const orientationsMatch = directionToOrientation(thisObject.direction) == thatObject.orientation || getOppositeOrientation(directionToOrientation(thisObject.direction)) == thatObject.orientation;
            //     if (thisObject.isBullet && thatObject.isObstacle && thatObject.typeString?.includes("wall_ext") && !thatObject.typeString?.includes("thicker") && orientationsMatch && (thatObject as Obstacle).bunkerWall){
            //         // console.log(thatObject.typeString);
            //         console.log(directionToOrientation(thisObject.direction),thatObject.typeString, thatObject.orientation, (thatObject as Obstacle).bunkerWall);
            //         return false;
            //     }
            // }
            // if (thisObject.isProjectile){
            //     let onStair = false;
            //     for (const stair of thisObject.game.stairs) {
            //             if (stair.check(thisObject)) {
            //                 onStair = true;
            //                 break;
            //             }
            //         }
            //         const orientationsMatch = directionToOrientation((thisObject as Projectile).direction) == thatObject.orientation || getOppositeOrientation(directionToOrientation((thisObject as Projectile).direction)) == thatObject.orientation;
            //     if (thisObject.isProjectile && thatObject.isObstacle && thatObject.typeString?.includes("wall_ext") && !thatObject.typeString?.includes("thicker") && orientationsMatch && (thatObject as Obstacle).bunkerWall){
            //             // console.log(thatObject.typeString);
            //             console.log(directionToOrientation((thisObject as Projectile).direction),thatObject.typeString, thatObject.orientation, (thatObject as Obstacle).bunkerWall);
            //             return false;
            //         }
            // }
            // if (thisObject.isProjectile){
            // console.log(thisObject.typeString + ":", directionToOrientation((thisObject as Projectile).direction), display + ":", thatObject.orientation);
            // }
            // if (thatObject.typeString == "concrete_wall_ext_25"){
            // const {height, bunkerWall, collidable, orientation} = (thatObject as Obstacle);
            // console.log(thisObject.layer);
            // console.log(height, bunkerWall, collidable, orientation);
            // }
            // const bad = [
            //     "concrete_wall_ext_5",
            //     "metal_wall_ext_5",
            //     "concrete_wall_ext_4",
            //     "concrete_wall_ext_25"
            // ];
            // if (thisObject.isProjectile && bad.includes(thatObject.typeString) && (thatObject as Obstacle).bunkerWall){
            //     return false;
            // }
            // Prevents collision with invisible walls in bunker entrances
            if (thisObject.isPlayer && thatObject.isObstacle && thisObject.layer & 0x2 && thatObject.bunkerWall) {
                return false;
            }
            else if (thisObject.isObstacle && thatObject.isPlayer && thatObject.layer & 0x2 && thisObject.bunkerWall) {
                return false;
            }
            if (thisObject.isProjectile && thatObject.collidesWith.projectile) {
                return thisObject.zPos < thatObject.height;
            }
            else if (thatObject.isProjectile && thisObject.collidesWith.projectile) {
                return thatObject.zPos < thisObject.height;
            }
            if (thisObject.isPlayer)
                return thatObject.collidesWith.player;
            else if (thisObject.isObstacle)
                return thatObject.collidesWith.obstacle;
            else if (thisObject.isBullet)
                return thatObject.collidesWith.bullet;
            else if (thisObject.isLoot)
                return thatObject.collidesWith.loot;
            else if (thisObject.isProjectile)
                return thatObject.collidesWith.projectile;
            else
                return false;
        };
        this.map = new map_1.GameMap(this, "main");
        this.gas.posOld = new planck_1.Vec2(this.map.width / 2, this.map.height / 2);
        this.gas.posNew = new planck_1.Vec2(this.map.width / 2, this.map.height / 2);
        this.gas.currentPos = new planck_1.Vec2(this.map.width, this.map.height);
        this.gas.currentRad = this.map.width;
        this.tick(1000 / 240);
    }
    tickTimes = [];
    tick(delay) {
        setTimeout(() => {
            const tickStart = Date.now();
            // Update physics
            this.world.step(12.5);
            // Create an alive count packet
            if (this.aliveCountDirty)
                this.aliveCounts = new aliveCountsPacket_1.AliveCountsPacket(this);
            // Update loot positions
            for (const loot of this.loot) {
                if (loot.oldPos.x !== loot.position.x || loot.oldPos.y !== loot.position.y) {
                    this.partialDirtyObjects.add(loot);
                }
                loot.oldPos = loot.position.clone();
            }
            // Update bullets
            for (const bullet of this.bullets) {
                if (bullet.distance >= bullet.maxDistance) {
                    const bulletData = data_1.Bullets[bullet.typeString];
                    if (bulletData.onHit) {
                        const explosionPosition = bullet.position.clone().add(bullet.direction.clone().mul(bullet.maxDistance));
                        this.explosions.add(new explosion_1.Explosion(explosionPosition, bulletData.onHit, bullet.layer, bullet.shooter, bullet.shotSource));
                    }
                    this.world.destroyBody(bullet.body);
                    this.bullets.delete(bullet);
                }
            }
            // Do damage to objects hit by bullets
            for (const damageRecord of this.damageRecords) {
                const bullet = damageRecord.bullet;
                const bulletData = data_1.Bullets[bullet.typeString];
                if (bulletData.onHit) {
                    this.explosions.add(new explosion_1.Explosion(bullet.body.getPosition(), bulletData.onHit, bullet.layer, bullet.shooter, bullet.shotSource));
                }
                if (damageRecord.damaged.damageable) {
                    if (damageRecord.damaged instanceof player_1.Player) {
                        // console.log(bulletData);
                        damageRecord.damaged.damage(bulletData.damage, damageRecord.damager, bullet.shotSource);
                    }
                    else {
                        damageRecord.damaged.damage(bulletData.damage * bulletData.obstacleDamage, damageRecord.damager);
                    }
                }
                this.world.destroyBody(bullet.body);
                this.bullets.delete(bullet);
            }
            // Update red zone
            if (this.gas.mode !== 0) {
                this.gas.duration = (Date.now() - this.gas.countdownStart) / 1000 / this.gas.initialDuration;
                this.gasCircleDirty = true;
            }
            // Red zone damage
            this.ticksSinceLastGasDamage++;
            let gasDamage = false;
            if (this.ticksSinceLastGasDamage >= 67) {
                this.ticksSinceLastGasDamage = 0;
                gasDamage = true;
                if (this.gas.mode === 2) {
                    this.gas.currentPos = (0, math_1.vecLerp)(this.gas.duration, this.gas.posOld, this.gas.posNew);
                    this.gas.currentRad = (0, math_1.lerp)(this.gas.duration, this.gas.radOld, this.gas.radNew);
                }
            }
            // stop players from joining game after timePeriodToAllowJoin has elapsed
            if (Date.now() - this.lobbyStartTime >= this.timePeriodToAllowJoin && this.allowJoin) {
                this.allowJoin = false;
            }
            // First loop over players: Calculate movement & animations
            for (const p of this.livingPlayers) {
                // console.log(p.distanceToMouse);
                // console.log(p.distanceToMouse/p.zoom);
                // console.log(p.zoom, p.distanceToMouse);
                // Movement
                if (p.isMobile) {
                    if (this.gamemode == constants_1.GameMode.DeathMatch) {
                        p.setVelocity(p.touchMoveDir.x * p.speed, p.touchMoveDir.y * p.speed);
                    }
                    else if (this.gamemode == constants_1.GameMode.BattleRoyale) {
                        p.setVelocity(p.touchMoveDir.x * p.speed, p.touchMoveDir.y * p.speed);
                        // if (this.allowJoin == false){
                        //     p.setVelocity(p.touchMoveDir.x * p.speed, p.touchMoveDir.y * p.speed);
                        // }
                    }
                }
                else {
                    if (this.gamemode == constants_1.GameMode.DeathMatch) {
                        p.setMovement();
                    }
                    else if (this.gamemode == constants_1.GameMode.BattleRoyale) {
                        p.setMovement();
                        // //only allow players to move in battle royale after lobby closes (meaning game has started)
                        // if (this.allowJoin == false){
                        //     p.setMovement();
                        // }
                    }
                }
                // Pick up nearby items if on mobile
                if (p.isMobile) {
                    for (const object of p.visibleObjects) {
                        if (object instanceof loot_1.Loot &&
                            (!object.isGun || (p.weapons[0].typeId === 0 || p.weapons[1].typeId === 0) || (data_1.Weapons[p.activeWeapon.typeString]?.dualWieldType && data_1.Weapons[object.typeString]?.dualWieldType && p.activeWeapon.typeId === object.typeId)) &&
                            !object.isMelee &&
                            (0, math_1.distanceBetween)(p.position, object.position) <= p.scale + constants_1.Constants.player.touchLootRadMult) {
                            p.interactWith(object);
                        }
                    }
                }
                if (this.gamemode == constants_1.GameMode.DeathMatch) {
                    p.updateHealthAndAdren();
                }
                else if (this.gamemode == constants_1.GameMode.BattleRoyale) {
                    if (!this.allowJoin) {
                        p.updateHealthAndAdren();
                    }
                }
                // Red zone damage
                if (gasDamage && this.isInRedZone(p.position)) {
                    p.damage(this.gas.damage, undefined, undefined, constants_1.DamageType.Gas);
                }
                // if player is being revived, cancel revive if either player move out of range
                if (p.playerBeingRevived) {
                    if ((0, math_1.distanceBetween)(p.position, p.playerBeingRevived.position) > constants_1.Constants.player.reviveRange) {
                        p.cancelAction();
                    }
                }
                // Perform action again
                if (p.performActionAgain) {
                    p.performActionAgain = false;
                    p.doAction(p.lastActionItem.typeString, p.lastActionItem.duration, p.lastActionType);
                }
                // Action item logic
                if (p.actionDirty && Date.now() - p.actionItem.useEnd > 0) {
                    if (p.actionType === constants_1.Constants.Action.UseItem) {
                        switch (p.actionItem.typeString) {
                            case "bandage":
                                p.health += 15;
                                break;
                            case "healthkit":
                                p.health = 100;
                                break;
                            case "soda":
                                p.boost += 25;
                                break;
                            case "painkiller":
                                p.boost += 50;
                                break;
                        }
                        p.inventory[p.actionItem.typeString]--;
                        p.inventoryDirty = true;
                    }
                    else if (p.actionType === constants_1.Constants.Action.Reload) {
                        const weaponInfo = p.activeWeaponInfo;
                        // let difference = Math.min(p.inventory[weaponInfo.ammo], weaponInfo.maxClip - (p.activeWeapon as Gun).ammo);
                        let difference = Math.min(p.inventory[weaponInfo.ammo], p.activeWeapon.customClip - p.activeWeapon.ammo);
                        // when mosin ammo reaches 0, do a full reload rather than incremental
                        if (weaponInfo.name == "Mosin-Nagant" && difference == weaponInfo.maxReloadAlt) {
                            difference = weaponInfo.maxReloadAlt;
                        }
                        else {
                            if (difference > weaponInfo.maxReload) {
                                difference = weaponInfo.maxReload;
                                p.performActionAgain = true;
                            }
                        }
                        p.activeWeapon.ammo += difference;
                        p.inventory[weaponInfo.ammo] -= difference;
                        p.weaponsDirty = true;
                        p.inventoryDirty = true;
                    }
                    else if (p.actionType === constants_1.Constants.Action.Revive) {
                        const playerRevived = p.playerBeingRevived;
                        if (playerRevived) {
                            playerRevived.downed = false;
                            playerRevived.health = constants_1.Constants.player.reviveHealth;
                            playerRevived.recalculateSpeed();
                            playerRevived.fullDirtyObjects.add(playerRevived);
                            this.fullDirtyObjects.add(playerRevived);
                        }
                    }
                    if (p.performActionAgain) {
                        p.lastActionItem = { ...p.actionItem };
                        p.lastActionType = p.actionType;
                    }
                    p.cancelAction();
                }
                // console.log(p.anim);
                // console.log(p.actionSeq);
                // Weapon logic
                if (p.shootStart) {
                    p.shootStart = false;
                    // I put this outside b/c it would not work inside
                    if (p.weaponCooldownOver()) {
                        if (p.activeWeapon.weaponType === constants_1.WeaponType.Throwable) {
                            if (!p.anim.active) {
                                p.cancelAction();
                                p.anim.active = true;
                                p.anim.type = constants_1.Constants.Anim.Cook;
                                p.anim.seq = 1;
                                p.anim.time = 0;
                                p.anim.duration = 4 * 30;
                                p.fullDirtyObjects.add(p);
                                this.fullDirtyObjects.add(p);
                                p.recalculateSpeed();
                            }
                            p.ticksSinceCookStart = 0;
                        }
                        else {
                            // we do not want the cooldown timer to start if throwing a nade
                            p.activeWeapon.cooldown = Date.now();
                            if (p.activeWeapon.weaponType === constants_1.WeaponType.Melee) {
                                p.useMelee();
                            }
                            else if (p.activeWeapon.weaponType === constants_1.WeaponType.Gun) {
                                p.shootGun();
                            }
                        }
                    }
                    // if (p.weaponCooldownOver()) {
                    //     p.activeWeapon.cooldown = Date.now();
                    //     if (p.activeWeapon.weaponType === WeaponType.Melee) {
                    //         p.useMelee();
                    //     } else if (p.activeWeapon.weaponType === WeaponType.Gun) {
                    //         p.shootGun();
                    //     }
                    // }
                }
                else if (p.shootHold && p.activeWeapon.weaponType === constants_1.WeaponType.Gun && (p.activeWeaponInfo.fireMode === "auto" || p.activeWeaponInfo.fireMode === "burst")) {
                    if (p.weaponCooldownOver()) {
                        p.activeWeapon.cooldown = Date.now();
                        p.shootGun();
                    }
                }
                else if (p.shootHold && p.activeWeapon.weaponType === constants_1.WeaponType.Throwable && p.ticksSinceCookStart != data_1.Weapons[p.activeWeapon.typeString].fuseTime * 30) {
                    if (p.weaponCooldownOver() && p.anim.active) {
                        p.ticksSinceCookStart++;
                    }
                }
                else if (p.ticksSinceCookStart >= 0) {
                    if (Date.now() - p.weapons[3].cooldown >= p.weapons[3].cooldownDuration) {
                        p.weapons[3].cooldown = Date.now();
                        p.useThrowable();
                        p.anim.active = false;
                        p.anim.type = 0;
                        p.anim.seq = 0;
                        p.anim.time = -1;
                        p.anim.duration = 0;
                        p.ticksSinceCookStart = -1;
                        p.recalculateSpeed();
                        p.fullDirtyObjects.add(p);
                    }
                    else {
                        p.ticksSinceCookStart = -1;
                    }
                }
                else {
                    p.ticksSinceCookStart = -1;
                    p.shooting = false;
                }
                // Animation logic
                if (p.anim.active)
                    p.anim.time++;
                if (p.anim.time > p.anim.duration) {
                    p.anim.active = false;
                    this.fullDirtyObjects.add(p);
                    p.fullDirtyObjects.add(p);
                    p.anim.type = p.anim.seq = 0;
                    p.anim.time = -1;
                }
                else if (p.moving) {
                    p.game.partialDirtyObjects.add(p);
                    p.partialDirtyObjects.add(p);
                }
                p.moving = false;
                // Stair logic
                let onStair = false;
                const originalLayer = p.layer;
                for (const stair of this.stairs) {
                    if (stair.check(p)) {
                        onStair = true;
                        break;
                    }
                }
                if (!onStair) {
                    if (p.layer === 2)
                        p.layer = 0;
                    if (p.layer === 3)
                        p.layer = 1;
                }
                if (p.layer !== originalLayer) {
                    p.fullDirtyObjects.add(p);
                    p.game.fullDirtyObjects.add(p);
                }
                // Logic for scopes in buildings
                let playerZoomFromBuilding = 0;
                for (const building of p.nearObjects) {
                    if (building instanceof building_1.Building && building.playerIsOnZoomArea(p) !== 0) {
                        playerZoomFromBuilding = building.playerIsOnZoomArea(p);
                        break;
                    }
                }
                p.buildingZoom = playerZoomFromBuilding;
            }
            for (const proj of this.projectiles) {
                proj.update();
            }
            for (const explosion of this.explosions) {
                explosion.explode(this);
            }
            // Second loop over players: calculate visible objects & send packets
            for (const p of this.connectedPlayers) {
                // Calculate visible objects
                if (p.movesSinceLastUpdate > 8 || this.updateObjects) {
                    p.updateVisibleObjects();
                }
                // Update role
                if (p.roleLost) {
                    p.roleLost = false;
                    p.role = 0;
                }
                // Spectate logic
                if (p.spectateBegin) {
                    p.spectateBegin = false;
                    let toSpectate;
                    if ((p.killedBy != null) && !p.killedBy.dead)
                        toSpectate = p.killedBy;
                    else
                        toSpectate = this.randomPlayer();
                    p.spectate(toSpectate);
                }
                else if (p.spectateNext && (p.spectating != null)) { // TODO Remember which players were spectated so navigation works properly
                    p.spectateNext = false;
                    let index = this.spectatablePlayers.indexOf(p.spectating) + 1;
                    if (index >= this.spectatablePlayers.length)
                        index = 0;
                    p.spectate(this.spectatablePlayers[index]);
                }
                else if (p.spectatePrevious && (p.spectating != null)) {
                    p.spectatePrevious = false;
                    let index = this.spectatablePlayers.indexOf(p.spectating) - 1;
                    if (index < 0)
                        index = this.spectatablePlayers.length - 1;
                    p.spectate(this.spectatablePlayers[index]);
                }
                // Emotes
                // TODO Determine which emotes should be sent to the client
                if (this.emotes.size) {
                    for (const emote of this.emotes) {
                        if (!emote.isPing || emote.playerId === p.id)
                            p.emotes.add(emote);
                    }
                }
                // Explosions
                // TODO Determine which explosions should be sent to the client
                if (this.explosions.size) {
                    for (const explosion of this.explosions) {
                        p.explosions.add(explosion);
                    }
                }
                // Full objects
                if (this.fullDirtyObjects.size) {
                    for (const object of this.fullDirtyObjects) {
                        if (p.visibleObjects.has(object) && !p.fullDirtyObjects.has(object)) {
                            p.fullDirtyObjects.add(object);
                        }
                    }
                }
                // Partial objects
                if (this.partialDirtyObjects.size && !p.fullUpdate) {
                    for (const object of this.partialDirtyObjects) {
                        if (p.visibleObjects.has(object) && !p.fullDirtyObjects.has(object)) {
                            p.partialDirtyObjects.add(object);
                        }
                    }
                }
                // Deleted objects
                if (this.deletedObjects.size) {
                    for (const object of this.deletedObjects) {
                        /* if(p.visibleObjects.includes(object) && object !== p) {
                            p.deletedObjects.add(object);
                        } */
                        if (object !== p)
                            p.deletedObjects.add(object);
                    }
                }
                // Send packets
                if (!p.isSpectator) {
                    const updatePacket = new updatePacket_1.UpdatePacket(p);
                    const updateStream = survivBitStream_1.SurvivBitStream.alloc(updatePacket.allocBytes);
                    updatePacket.serialize(updateStream);
                    p.sendData(updateStream);
                    for (const spectator of p.spectators) {
                        spectator.sendData(updateStream);
                    }
                }
                if (this.aliveCountDirty)
                    p.sendPacket(this.aliveCounts);
                for (const kill of this.kills)
                    p.sendPacket(kill);
                for (const roleAnnouncement of this.roleAnnouncements)
                    p.sendPacket(roleAnnouncement);
            }
            // Reset everything
            if (this.fullDirtyObjects.size)
                this.fullDirtyObjects = new Set();
            if (this.partialDirtyObjects.size)
                this.partialDirtyObjects = new Set();
            if (this.deletedObjects.size)
                this.deletedObjects = new Set();
            if (this.newPlayers.size)
                this.newPlayers = new Set();
            if (this.deletedPlayers.size)
                this.deletedPlayers = new Set();
            if (this.emotes.size)
                this.emotes = new Set();
            if (this.explosions.size)
                this.explosions = new Set();
            if (this.newBullets.size)
                this.newBullets = new Set();
            if (this.kills.size)
                this.kills = new Set();
            if (this.roleAnnouncements.size)
                this.roleAnnouncements = new Set();
            if (this.damageRecords.size)
                this.damageRecords = new Set();
            this.gasDirty = false;
            this.gasCircleDirty = false;
            this.aliveCountDirty = false;
            // Stop the tick loop if the game is over
            if (this.over) {
                for (const player of this.connectedPlayers) {
                    try {
                        player.socket.close();
                    }
                    catch (e) { }
                }
                return;
            }
            // Record performance and start the next tick
            const tickTime = Date.now() - tickStart;
            this.tickTimes.push(tickTime + delay);
            if (this.tickTimes.length >= 200) {
                (0, misc_1.log)(`Average ms/tick: ${this.tickTimes.reduce((a, b) => a + b) / this.tickTimes.length}`);
                this.tickTimes = [];
            }
            const newDelay = Math.max(0, (1000 / 240) - tickTime);
            this.tick(newDelay);
        }, delay);
    }
    isInRedZone(position) {
        // console.log(position, this.gas.currentPos, this.gas.currentRad);
        return (0, math_1.distanceBetween)(position, this.gas.currentPos) >= this.gas.currentRad;
    }
    get aliveCount() {
        return this.livingPlayers.size;
    }
    addPlayer(socket, name, loadout) {
        let numTeammates = 0;
        for (const player of this.livingPlayers) {
            if (player.loadout.outfit == data_1.TypeToId[loadout.outfit]) {
                numTeammates++;
            }
        }
        let groupId = data_1.TypeToId[loadout.outfit];
        /**
         * max number of players allowed per team
         */
        const maxTeammates = 2;
        // if numTeammates == maxTeammates, the team already has 4 people so the player can't join it
        if (numTeammates == maxTeammates) {
            groupId = data_1.TypeToId.outfitBase;
            loadout.outfit = "outfitBase";
        }
        let spawnPosition;
        if (!this.allowJoin)
            spawnPosition = (0, planck_1.Vec2)(360, 360);
        if (data_1.Debug.fixedSpawnLocation.length)
            spawnPosition = (0, planck_1.Vec2)(data_1.Debug.fixedSpawnLocation[0], data_1.Debug.fixedSpawnLocation[1]);
        else if (this.gas.currentRad <= 16)
            spawnPosition = this.gas.currentPos.clone();
        else {
            let foundPosition = false;
            while (!foundPosition) {
                //! unsafe
                spawnPosition = this.map.getRandomPositionFor(constants_1.ObjectKind.Player, undefined, 0, 1, undefined, undefined, groupId);
                if (!this.isInRedZone(spawnPosition))
                    foundPosition = true;
            }
        }
        const p = new player_1.Player(spawnPosition, socket, this, name, loadout);
        this.players.add(p);
        this.connectedPlayers.add(p);
        this.newPlayers.add(p);
        this.aliveCountDirty = true;
        this.playerInfosDirty = true;
        this.updateObjects = true;
        if (!this.allowJoin) {
            p.dead = true;
            p.spectate(this.randomPlayer());
        }
        else {
            p.updateVisibleObjects();
            this.livingPlayers.add(p);
            this.spectatablePlayers.push(p);
            p.fullDirtyObjects.add(p);
        }
        // this is where you add loot you want to spawn on the player when they join the game
        // do NOT do it inside the constructor
        // spawn m870 next to player so they can choose between spas12 and m870
        if (!p.isSpectator) {
            new loot_1.Loot(this, "m870", p.position, 0, 1);
            new loot_1.Loot(this, "famas", p.position, 0, 1);
            new loot_1.Loot(this, "scar", p.position, 0, 1);
            new loot_1.Loot(this, "scout", p.position, 0, 1);
            new loot_1.Loot(this, "deagle", p.position, 0, 1);
            new loot_1.Loot(this, "model94", p.position, 0, 1);
            new loot_1.Loot(this, "mk12", p.position, 0, 1);
            new loot_1.Loot(this, "m4a1", p.position, 0, 1);
            new loot_1.Loot(this, "qbb97", p.position, 0, 1);
            new loot_1.Loot(this, "m1a1", p.position, 0, 1);
            new loot_1.Loot(this, "mp220", p.position, 0, 1);
            // new Loot(this, "usas", p.position, 0, 1);
            // new Loot(this, "sv98", p.position, 0, 1);
            // new Loot(this, "mirv", p.position, 0, 1);
        }
        this.dynamicObjects.add(p);
        this.fullDirtyObjects.add(p);
        p.sendPacket(new joinedPacket_1.JoinedPacket(p));
        const stream = survivBitStream_1.SurvivBitStream.alloc(32768);
        new mapPacket_1.MapPacket(p).serialize(stream);
        new updatePacket_1.UpdatePacket(this.allowJoin ? p : p.spectating).serialize(stream);
        new aliveCountsPacket_1.AliveCountsPacket(this).serialize(stream);
        p.sendData(stream);
        if (this.aliveCount > 1 && !this.started) {
            this.started = true;
            this.lobbyStartTime = Date.now();
            // setTimeout(() => {
            //     this.allowJoin = false;
            // }, this.timePeriodToAllowJoin);
            this.advanceRedZone();
        }
        return p;
    }
    advanceRedZone() {
        if (data_1.Debug.disableRedZone)
            return;
        const currentStage = data_1.RedZoneStages[this.gamemode][this.gas.stage + 1];
        if (!currentStage)
            return;
        this.gas.stage++;
        this.gas.mode = currentStage.mode;
        this.gas.initialDuration = currentStage.duration;
        this.gas.duration = 1;
        this.gas.countdownStart = Date.now();
        if (currentStage.mode === 1) {
            this.gas.posOld = this.gas.posNew.clone();
            // this.gas.posOld = new Vec2(100, 100);
            if (currentStage.radNew !== 0) {
                this.gas.posNew = (0, math_1.randomPointInsideCircle)(this.gas.posOld, (currentStage.radOld - currentStage.radNew) / 4);
                // this.gas.posNew = randomPointInsideCircle(new Vec2(157.5,157.5), 10);
            }
            else {
                this.gas.posNew = this.gas.posOld.clone();
            }
            this.gas.currentPos = this.gas.posOld.clone();
            this.gas.currentRad = currentStage.radOld;
        }
        this.gas.radOld = currentStage.radOld;
        this.gas.radNew = currentStage.radNew;
        this.gas.damage = currentStage.damage;
        this.gasDirty = true;
        this.gasCircleDirty = true;
        // Start the next stage
        if (currentStage.duration !== 0) {
            setTimeout(() => this.advanceRedZone(), currentStage.duration * 1000);
        }
    }
    removePlayer(p) {
        if (this.aliveCount > 0) {
            const randomPlayer = this.randomPlayer();
            for (const spectator of p.spectators) {
                spectator.spectate(randomPlayer);
            }
            p.spectators = new Set();
        }
        else {
            this.end();
        }
        if (p.spectating != null) {
            p.spectating.spectators.delete(p);
            p.spectating.spectatorCountDirty = true;
        }
        p.movingUp = false;
        p.movingDown = false;
        p.movingLeft = false;
        p.movingRight = false;
        p.shootStart = false;
        p.shootHold = false;
        p.isSpectator = false;
        p.spectating = undefined;
        p.actionType = p.actionSeq = 0;
        p.anim.type = p.anim.seq = 0;
        this.livingPlayers.delete(p);
        this.connectedPlayers.delete(p);
        (0, misc_1.removeFrom)(this.spectatablePlayers, p);
        if (!p.dead) {
            // If player is dead, alive count has already been decremented
            this.aliveCountDirty = true;
            if (false) {
                // this.dynamicObjects.delete(p);
                // this.partialDirtyObjects.delete(p);
                // this.fullDirtyObjects.delete(p);
                // this.deletedPlayers.add(p);
                // this.deletedObjects.add(p);
                // p.direction = Vec2(1, 0);
                p.disconnected = true;
                // p.deadPos = p.body.getPosition().clone();
                // this.world.destroyBody(p.body);
                // this.fullDirtyObjects.add(p);
            }
            else {
                p.direction = (0, planck_1.Vec2)(1, 0);
                p.disconnected = true;
                // p.deadPos = p.body.getPosition().clone();
                if (p.downed) {
                    p.damage(p.health, undefined, undefined, constants_1.DamageType.Gas);
                }
                this.fullDirtyObjects.add(p);
            }
        }
    }
    randomPlayer() {
        if (this.aliveCount === 0)
            return;
        return [...this.livingPlayers][(0, math_1.random)(0, this.livingPlayers.size - 1)];
    }
    assignKillLeader(p) {
        this.killLeaderDirty = true;
        if (this.killLeader !== p || !p.dead) { // If the player isn't already the Kill Leader, and isn't dead.
            p.role = data_1.TypeToId.kill_leader;
            this.killLeader = p;
            this.roleAnnouncements.add(new roleAnnouncementPacket_1.RoleAnnouncementPacket(p, true, false));
        }
    }
    end() {
        (0, misc_1.log)("Game ending");
        if (data_1.Config.stopServerOnGameEnd)
            process.exit(1);
        this.over = true;
        for (const p of this.connectedPlayers) {
            if (!p.disconnected) {
                try {
                    p.socket.close();
                }
                catch (e) { }
            }
        }
    }
    get nextObjectId() {
        this._nextObjectId++;
        return this._nextObjectId;
    }
    get nextGroupId() {
        this._nextGroupId++;
        return this._nextGroupId;
    }
}
exports.Game = Game;
//# sourceMappingURL=game.js.map
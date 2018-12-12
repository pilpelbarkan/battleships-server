const AWS = require("aws-sdk");

const awsAccessKey = 'NOT_MY_REAL_KEY';
const awsSecretKey = '*****************';

AWS.config.update({
    region: "us-east-1",
    endpoint: "https://dynamodb.us-east-1.amazonaws.com",
    accessKeyId: awsAccessKey,
    secretAccessKey: awsSecretKey,
});

const docClient = new AWS.DynamoDB.DocumentClient();

const table = "User";

function checkUserPassword(username, password) {

    return new Promise((resolve,reject)=>{

        const params = {
            TableName: table,
            Key: {
                name: username
            }
        };

        docClient.get(params, function (err, data) {
            if (err) {
                console.error('ERROR:', err);
                return resolve( {error: true, result: `failed`, reason: err} );
            }
            if (data.Item === undefined) {
                console.log(`User ${username} does not exist`);
                return resolve({error: false, result: `failed`, reason: `user doesn't exist`})
            }
            if (data.Item.password !== password) {
                console.log(`Incorrect password ${password} for ${username}, should be ${data.Item.password}`);
                return resolve({error: false, result: `failed`, reason: `incorrect password`})
            }
            return resolve({error: false, result: `success`, data: data.Item})
        });
    })
}

function registerNewUser(username, password = '') {

    return new Promise((resolve,reject)=> {

        const params = {
            TableName: table,
            Item: {
                name: username,
                password,
                plays: 0,
                wins: 0
            }
        };

        docClient.put(params, function (err, data) {
            if (err) {
                console.error('ERROR:', err);
                return resolve({error: true, result: `failed`, reason: err})
            }
            console.log(`Saved ${JSON.stringify(params.Item)}`);
            return resolve({error: false, result: `success`, data: params.Item})
        });
    });
}

function updateUserData(username, wins, plays) {

    return new Promise((resolve,reject)=> {


        const params = {
            TableName: table,
            Key: {
                name: username
            },
            UpdateExpression: "set wins = :w, plays=:p",
            ExpressionAttributeValues: {
                ":w": wins,
                ":p": plays
            },
            ReturnValues: "UPDATED_NEW"
        };

        return docClient.update(params, function (err, data) {
            if (err) {
                console.error("Unable to update item. Error JSON:", JSON.stringify(err, null, 2));
                return resolve({error: true, result: `failed`, reason: `user does not exists`})
            }
            return resolve({error: false, result: `success`})
        });
    });
}

module.exports = {
    registerNewUser,
    checkUserPassword,
    updateUserData,
};

